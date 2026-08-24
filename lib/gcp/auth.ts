/**
 * §14.4 — Secrets, and how the app proves who it is to Google.
 *
 * One GCP service account covers BigQuery, the GA4 Data API, Sheets, and Cloud
 * Logging. There are two ways it can authenticate, tried in this order:
 *
 *   1. A service-account KEY in `GCP_SA_KEY_JSON` (base64 or raw JSON), decoded
 *      at runtime into a credentials object — never written to disk. This is the
 *      path for hosts that live *outside* Google (e.g. Vercel), where a key is
 *      the only option.
 *
 *   2. Application Default Credentials (ADC) — no key at all. This is what runs
 *      inside Kubernetes/GKE via Workload Identity, and what `gcloud auth
 *      application-default login` provides on a laptop. ADC is the intended
 *      production path (ADR-007, and what the PM asked for): the cluster already
 *      has access to both GCP projects, so the app inherits it with no
 *      downloadable key — which the org's policy does not permit issuing anyway.
 *
 * The key path signs a self-signed JWT; ADC either refreshes the local gcloud
 * credential or asks the GKE metadata server for a token. Both avoid pulling in
 * the full googleapis SDK for what is ~120 lines of well-understood HTTP.
 */
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '@/lib/config';

export const GCP_SCOPES = [
  'https://www.googleapis.com/auth/bigquery.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/logging.read',
] as const;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

/**
 * Cached against the raw credential, not merely "cached".
 *
 * `config` is built once at import from `process.env`, so a key that arrives
 * later — which is exactly what "Test connection" does, by setting
 * `GCP_SA_KEY_JSON` for the length of one call — was invisible. Every GCP
 * connection test failed with "GCP_SA_KEY_JSON not configured", including the
 * ones holding a perfectly good key, and the message blamed the credential.
 *
 * Reading `process.env` first and keying the cache on the value fixes both: a
 * new key is picked up, and an unchanged one is still parsed once.
 */
let cachedKey: ServiceAccountKey | null | undefined;
let cachedFrom: string | undefined;

function rawKeyJson(): string {
  return (process.env.GCP_SA_KEY_JSON ?? config.gcpSaKeyJson ?? '').trim();
}

export function serviceAccountKey(): ServiceAccountKey | null {
  const rawInput = rawKeyJson();
  if (cachedKey !== undefined && cachedFrom === rawInput) return cachedKey;
  cachedFrom = rawInput;
  if (!rawInput) {
    cachedKey = null;
    return null;
  }
  try {
    const raw = rawInput;
    // Accept either raw JSON or base64, so a paste-in-Vercel mistake is survivable.
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as ServiceAccountKey;
    cachedKey = parsed.client_email && parsed.private_key ? parsed : null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

/* ── Application Default Credentials (the no-key path) ──────────────────────
 *
 * Detection is deliberately synchronous and cheap so `isGcpConfigured()` stays
 * a cheap check — it decides fixture-vs-live for every GCP connector on every
 * page render, and must not make a network call or block. There are three ways
 * ADC can be present, mirroring Google's own resolution order:
 *
 *   a. GOOGLE_APPLICATION_CREDENTIALS points at a credentials file.
 *   b. The gcloud well-known file exists (`gcloud auth application-default
 *      login` writes it) — this is the local-laptop case.
 *   c. We are told we are on GKE/GCE (GCP_USE_ADC set by the deployment, or
 *      GCE_METADATA_HOST present). The metadata server can only be *used*
 *      async, but whether to try it is a cheap flag check.
 *
 * (c) is an explicit flag rather than a blind metadata probe on purpose: this
 * codebase does not silently guess its environment (ADR-000). Infra sets
 * `GCP_USE_ADC=true` on the k8s Deployment; nothing tries the metadata server
 * off-cluster and hangs.
 */

type AuthorizedUser = {
  type: 'authorized_user';
  client_id: string;
  client_secret: string;
  refresh_token: string;
};
type AdcFile = AuthorizedUser | (ServiceAccountKey & { type?: 'service_account' });

function adcFilePath(): string | null {
  const explicit = (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  if (explicit && existsSync(explicit)) return explicit;
  const base = (process.env.CLOUDSDK_CONFIG ?? '').trim() || join(homedir(), '.config', 'gcloud');
  const wellKnown = join(base, 'application_default_credentials.json');
  return existsSync(wellKnown) ? wellKnown : null;
}

function metadataAdcEnabled(): boolean {
  const flag = (process.env.GCP_USE_ADC ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || Boolean(process.env.GCE_METADATA_HOST);
}

/** True when ADC is available without a key — a local gcloud login or a GKE flag. */
export function isAdcConfigured(): boolean {
  return adcFilePath() !== null || metadataAdcEnabled();
}

export function isGcpConfigured(): boolean {
  return serviceAccountKey() !== null || isAdcConfigured();
}

/**
 * Keyed by account **and** scopes.
 *
 * A single global token cache returns whichever token was fetched first. Test
 * one service account, then another, and the second reports "connected" on the
 * first one's token — a credential that was never checked, reported as working.
 * With two projects and two keys in play that is not hypothetical.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function cacheGet(cacheKey: string): string | null {
  const hit = tokenCache.get(cacheKey);
  return hit && hit.expiresAt > Date.now() + 60_000 ? hit.token : null;
}

/** Signs a JWT for a service-account key and exchanges it for an access token. */
async function jwtAccessToken(key: ServiceAccountKey, scopes: readonly string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: scopes.join(' '),
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key.private_key.replace(/\\n/g, '\n'), 'base64url');
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`GCP token exchange failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return body.access_token;
}

/** Exchanges a stored gcloud refresh token (authorized_user ADC) for an access token. */
async function refreshTokenGrant(creds: AuthorizedUser): Promise<{ token: string; ttl: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`ADC refresh failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return { token: body.access_token, ttl: body.expires_in };
}

/** Asks the GKE/GCE metadata server for the workload's own token. */
async function metadataToken(): Promise<{ token: string; ttl: number }> {
  const host = process.env.GCE_METADATA_HOST || 'metadata.google.internal';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(
      `http://${host}/computeMetadata/v1/instance/service-accounts/default/token`,
      { headers: { 'Metadata-Flavor': 'Google' }, signal: controller.signal },
    );
    if (!res.ok) throw new Error(`metadata server returned ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    return { token: body.access_token, ttl: body.expires_in };
  } catch (e) {
    throw new Error(
      `ADC metadata token unavailable (${(e as Error).message}). ` +
        'Set GCP_USE_ADC only when running on GKE/GCE with Workload Identity.',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchanges credentials for an OAuth access token. Cached until ~1 min before
 * expiry. Prefers an explicit `GCP_SA_KEY_JSON` key; falls back to ADC (local
 * gcloud credential, then the GKE metadata server) when no key is set.
 *
 * ADC-issued tokens carry whatever scopes the underlying identity was granted
 * (the metadata server ignores a requested-scopes narrowing, and a gcloud login
 * grants cloud-platform), so `scopes` only affects the key path. The read-only
 * `GCP_SCOPES` are a ceiling for the key, not a promise ADC can widen.
 */
export async function getAccessToken(scopes: readonly string[] = GCP_SCOPES): Promise<string> {
  const key = serviceAccountKey();
  if (key) {
    const cacheKey = `${key.client_email}|${[...scopes].sort().join(' ')}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const token = await jwtAccessToken(key, scopes);
    // JWT tokens are valid ~1h; store conservatively without trusting a body TTL.
    tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 3600_000 });
    return token;
  }

  // No key → Application Default Credentials.
  const file = adcFilePath();
  if (file) {
    const cacheKey = `adc-file|${file}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    let parsed: AdcFile;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as AdcFile;
    } catch (e) {
      throw new Error(`ADC file at ${file} is unreadable: ${(e as Error).message}`);
    }
    if ('type' in parsed && parsed.type === 'authorized_user') {
      const { token, ttl } = await refreshTokenGrant(parsed);
      tokenCache.set(cacheKey, { token, expiresAt: Date.now() + ttl * 1000 });
      return token;
    }
    if ('private_key' in parsed && parsed.private_key) {
      // A service-account key pointed at by GOOGLE_APPLICATION_CREDENTIALS.
      const token = await jwtAccessToken(parsed, scopes);
      tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 3600_000 });
      return token;
    }
    // external_account (Workload Identity Federation) and other ADC shapes are
    // not supported here — they need the SDK's exchange flow. Fail honestly.
    throw new Error(
      `ADC file at ${file} is a credential type this app does not support ` +
        '(only authorized_user and service_account). Use GKE Workload Identity or a key.',
    );
  }

  if (metadataAdcEnabled()) {
    const cacheKey = 'adc-metadata';
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const { token, ttl } = await metadataToken();
    tokenCache.set(cacheKey, { token, expiresAt: Date.now() + ttl * 1000 });
    return token;
  }

  throw new Error(
    'No GCP credentials: set GCP_SA_KEY_JSON, run `gcloud auth application-default login`, ' +
      'or set GCP_USE_ADC=true on GKE with Workload Identity — see §13.2 / ADR-007.',
  );
}

export function resetTokenCache(): void {
  tokenCache.clear();
  cachedKey = undefined;
  cachedFrom = undefined;
}
