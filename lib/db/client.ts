/**
 * Postgres serving layer (§6.1).
 *
 * BigQuery is the system of record; Postgres is the serving layer. Leadership
 * opening the hub must not trigger a full-table BQ scan, and the dashboard must
 * still render when BQ access hiccups.
 *
 * When DATABASE_URL is absent the app still boots and serves fixtures (§14.5) —
 * that is Phase 0's whole point. `getDb()` returns null rather than throwing.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config, isDbConfigured } from '@/lib/config';
import { schema } from './schema';

type Db = PostgresJsDatabase<typeof schema>;

let client: ReturnType<typeof postgres> | null = null;
let db: Db | null = null;

export function getDb(): Db | null {
  if (!isDbConfigured()) return null;
  if (db) return db;
  // On Vercel each function instance holds its own pool, so keep it small and
  // make queries fail fast: a hung query should degrade to fixtures, never sit
  // until the 300s function timeout. Locally (ETL) we want a bigger pool and no
  // statement cap, because a backfill insert can legitimately run long.
  const onVercel = Boolean(process.env.VERCEL);
  client = postgres(config.databaseUrl, {
    max: onVercel ? 3 : 5,
    idle_timeout: 20,
    connect_timeout: 10,
    // Serverless (Vercel) reuses connections across invocations through the
    // Supabase pooler, where named prepared statements collide ("prepared
    // statement already exists"). Disabling prepares is the supported setting
    // for pooled/serverless Postgres and costs nothing at this query volume.
    prepare: false,
    ...(onVercel ? { connection: { statement_timeout: 15_000 } } : {}),
    // §28.6 — the read-only role is enforced at the database for /api/ask; this
    // pool is the read-write ETL/serving pool.
  });
  db = drizzle(client, { schema });
  return db;
}

/**
 * A separate, genuinely read-only connection for AI-generated SQL (§28.6).
 * The regex guard is a convenience; this role is the security boundary.
 */
let readonlyClient: ReturnType<typeof postgres> | null = null;

export function getReadonlySql(): ReturnType<typeof postgres> | null {
  const url = process.env.DATABASE_URL_READONLY ?? '';
  if (!url) return null;
  if (readonlyClient) return readonlyClient;
  readonlyClient = postgres(url, {
    max: 2,
    idle_timeout: 10,
    connect_timeout: 10,
    prepare: false,
    connection: { statement_timeout: 15_000 },
  });
  return readonlyClient;
}

export async function closeDb(): Promise<void> {
  await client?.end({ timeout: 5 });
  await readonlyClient?.end({ timeout: 5 });
  client = null;
  db = null;
  readonlyClient = null;
}

export { schema };
