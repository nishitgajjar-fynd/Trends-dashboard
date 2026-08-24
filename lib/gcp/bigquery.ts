/**
 * BigQuery over the REST API, with the cost guards from §16.7 built in.
 *
 * Every job is labelled (§15.2): when someone asks why the BQ bill moved,
 * labels are the only way to answer. Every job carries `maximumBytesBilled`.
 */
import { config } from '@/lib/config';
import { getAccessToken, isGcpConfigured } from './auth';

const BQ_BASE = 'https://bigquery.googleapis.com/bigquery/v2';

export type BqParamType = 'STRING' | 'DATE' | 'TIMESTAMP' | 'INT64' | 'BOOL';

export interface BqQueryOptions {
  query: string;
  params?: Record<string, string | number | boolean | string[]>;
  types?: Record<string, BqParamType | [BqParamType]>;
  /** Connector id — becomes a job label so cost is attributable. */
  connector: string;
  maximumBytesBilled?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  /**
   * Stop after this many rows. `0` (the default) means read every page.
   *
   * A cap is a truncation, and it is reported as one on the result — a caller
   * that asked for a bounded read gets a bounded read *and* is told the answer
   * is partial.
   */
  maxRows?: number;
  /** Rows per page. BigQuery caps a page at 10 MB regardless. */
  pageSize?: number;
}

export interface BqResult<T> {
  rows: T[];
  totalBytesProcessed: number;
  cacheHit: boolean;
  jobId: string | null;
  /**
   * True when `maxRows` stopped the read before BigQuery ran out of pages.
   *
   * Never inferred from the row count: a query returning exactly `maxRows`
   * rows and a query truncated at `maxRows` are indistinguishable by size, and
   * only one of them is a partial answer.
   */
  truncated: boolean;
  /** How many pages were fetched. One page used to be all anyone ever got. */
  pages: number;
}

export class BudgetError extends Error {
  constructor(
    readonly bytes: number,
    readonly budget: number,
  ) {
    super(
      `Query would scan ${(bytes / 1024 ** 3).toFixed(2)} GiB, over the ${(budget / 1024 ** 3).toFixed(2)} GiB budget — refusing to run`,
    );
    this.name = 'BudgetError';
  }
}

function toQueryParameter(
  name: string,
  value: string | number | boolean | string[],
  type: BqParamType | [BqParamType] | undefined,
) {
  if (Array.isArray(value)) {
    const elementType = Array.isArray(type) ? type[0] : 'STRING';
    return {
      name,
      parameterType: { type: 'ARRAY', arrayType: { type: elementType } },
      parameterValue: { arrayValues: value.map((v) => ({ value: String(v) })) },
    };
  }
  const t = (Array.isArray(type) ? type[0] : type) ?? 'STRING';
  return { name, parameterType: { type: t }, parameterValue: { value: String(value) } };
}

/** Decodes BigQuery's positional row format into plain objects. */
function decodeRows<T>(schema: { fields?: Array<{ name: string; type: string }> }, rows: Array<{ f: Array<{ v: unknown }> }>): T[] {
  const fields = schema.fields ?? [];
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    row.f.forEach((cell, i) => {
      const field = fields[i];
      if (!field) return;
      const v = cell.v;
      if (v === null || v === undefined) {
        out[field.name] = null;
      } else if (['INTEGER', 'INT64', 'FLOAT', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC'].includes(field.type)) {
        out[field.name] = Number(v);
      } else if (['BOOLEAN', 'BOOL'].includes(field.type)) {
        out[field.name] = v === 'true' || v === true;
      } else if (field.type === 'TIMESTAMP') {
        // BigQuery's REST API returns TIMESTAMP as epoch **seconds** in a string
        // (e.g. "1686847981.0"), not an ISO date. `new Date()` on that is invalid
        // ("Invalid time value"), so normalise to an ISO string the connectors
        // can parse. Fixtures carry ISO strings already; this only affects live
        // BigQuery reads.
        const secs = Number(v);
        out[field.name] = Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : v;
      } else {
        out[field.name] = v;
      }
    });
    return out as T;
  });
}

export function isBigQueryConfigured(): boolean {
  return isGcpConfigured();
}

/**
 * Runs a query and reads **every** page of the result.
 *
 * The version this replaces posted to `jobs.query` and returned `json.rows`.
 * BigQuery's `jobs.query` returns only the first page — at most 50,000 rows, or
 * less if the page hits its 10 MB ceiling — and hands back a `pageToken` for
 * the rest. That token was ignored.
 *
 * The consequence was invisible and severe. A catalogue of 6.5 M rows loaded
 * 50,000 of them, the mart filled, the assertions passed on what arrived, and
 * the connector reported `live`. Nothing anywhere said "this is the first page".
 * Every EAN past the cut would have classified as `absent_from_master` — the
 * most alarming reason in the §20.3 taxonomy, and entirely an artefact.
 *
 * The same call also treated an incomplete job as an empty one: `timeoutMs` is
 * how long the *request* waits, not how long the query may take, so any query
 * slower than 60 s returned `jobComplete: false` with no rows and was read as a
 * successful run over nothing.
 */
export async function runQuery<T = Record<string, unknown>>(opts: BqQueryOptions): Promise<BqResult<T>> {
  if (!isGcpConfigured()) throw new Error('GCP service account not configured — see §13.2');
  const token = await getAccessToken();
  const auth = { Authorization: `Bearer ${token}` };

  const queryParameters = Object.entries(opts.params ?? {}).map(([name, value]) =>
    toQueryParameter(name, value, opts.types?.[name]),
  );

  const maxRows = opts.maxRows ?? 0;
  const pageSize = opts.pageSize ?? 20_000;

  const body = {
    query: opts.query,
    useLegacySql: false,
    parameterMode: queryParameters.length ? 'NAMED' : undefined,
    queryParameters: queryParameters.length ? queryParameters : undefined,
    maximumBytesBilled: opts.maximumBytesBilled ?? config.bqMaxBytesBilled,
    dryRun: opts.dryRun ?? false,
    timeoutMs: opts.timeoutMs ?? 60_000,
    maxResults: maxRows > 0 ? Math.min(pageSize, maxRows) : pageSize,
    labels: { app: 'companion-dashboard', connector: opts.connector },
  };

  interface Page {
    schema?: { fields?: Array<{ name: string; type: string }> };
    rows?: Array<{ f: Array<{ v: unknown }> }>;
    totalBytesProcessed?: string;
    cacheHit?: boolean;
    jobReference?: { jobId?: string; location?: string };
    jobComplete?: boolean;
    pageToken?: string;
    errors?: Array<{ message?: string }>;
  }

  const res = await fetch(`${BQ_BASE}/projects/${config.gcpProjectId}/queries`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BigQuery ${res.status}: ${await res.text()}`);

  let page = (await res.json()) as Page;
  if (opts.dryRun) {
    return {
      rows: [],
      totalBytesProcessed: Number(page.totalBytesProcessed ?? 0),
      cacheHit: Boolean(page.cacheHit),
      jobId: page.jobReference?.jobId ?? null,
      truncated: false,
      pages: 0,
    };
  }

  const jobId = page.jobReference?.jobId ?? null;
  const location = page.jobReference?.location;
  const results = async (pageToken?: string): Promise<Page> => {
    if (!jobId) throw new Error('BigQuery returned no job reference');
    const url = new URL(`${BQ_BASE}/projects/${config.gcpProjectId}/queries/${jobId}`);
    url.searchParams.set('maxResults', String(maxRows > 0 ? Math.min(pageSize, maxRows) : pageSize));
    url.searchParams.set('timeoutMs', '60000');
    if (location) url.searchParams.set('location', location);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await fetch(url, { headers: auth });
    if (!r.ok) throw new Error(`BigQuery ${r.status}: ${await r.text()}`);
    return (await r.json()) as Page;
  };

  // An incomplete job is not an empty one. Poll until it finishes rather than
  // reporting a successful run over zero rows.
  for (let waited = 0; !page.jobComplete; waited += 5) {
    if (waited > 900) throw new Error(`BigQuery job ${jobId} did not finish within 15 minutes`);
    page = await results();
  }
  if (page.errors?.length) throw new Error(`BigQuery: ${page.errors[0].message ?? 'query failed'}`);

  const schema = page.schema ?? {};
  const rows: T[] = [];
  let pages = 0;
  let truncated = false;

  for (;;) {
    pages += 1;
    const decoded = page.rows ? decodeRows<T>(schema, page.rows) : [];
    if (maxRows > 0 && rows.length + decoded.length >= maxRows) {
      rows.push(...decoded.slice(0, maxRows - rows.length));
      // Truncated only if BigQuery had more to give. Hitting the cap exactly on
      // the last page is a complete answer.
      truncated = Boolean(page.pageToken) || decoded.length > maxRows - (rows.length - decoded.length);
      break;
    }
    rows.push(...decoded);
    if (!page.pageToken) break;
    page = await results(page.pageToken);
  }

  return {
    rows,
    totalBytesProcessed: Number(page.totalBytesProcessed ?? 0),
    cacheHit: Boolean(page.cacheHit),
    jobId,
    truncated,
    pages,
  };
}

/**
 * §16.7 — dry-run gate. On any query whose window exceeds 7 days, read
 * `totalBytesProcessed` first and refuse if it is over budget.
 */
export async function assertWithinBudget(opts: BqQueryOptions, budgetBytes?: number): Promise<number> {
  const budget = budgetBytes ?? Number(config.bqMaxBytesBilled);
  const dry = await runQuery({ ...opts, dryRun: true });
  if (dry.totalBytesProcessed > budget) throw new BudgetError(dry.totalBytesProcessed, budget);
  return dry.totalBytesProcessed;
}

/** §16.1 / §15.3 — schema and dataset discovery, the mandatory first step of Phase 2/3. */
/**
 * Every dataset in the project, through the REST API rather than
 * `INFORMATION_SCHEMA.SCHEMATA`.
 *
 * `SCHEMATA` is scoped to one region. Querying it unqualified returns only the
 * datasets in the default region — on `fynd-jio-impetus-prod` that is 16 of
 * 242, and the missing 226 included both GA4 exports and the Scan-and-Go
 * catalogue. The connection test drew the obvious conclusion from an incomplete
 * list and reported "No analytics_* dataset here", which was false.
 *
 * `datasets.list` is region-agnostic, costs nothing, and scans no bytes.
 */
export async function listDatasets(project = config.gcpProjectId): Promise<string[]> {
  const token = await getAccessToken();
  const out: string[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${BQ_BASE}/projects/${project}/datasets`);
    url.searchParams.set('maxResults', '1000');
    url.searchParams.set('all', 'false');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`BigQuery ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      datasets?: Array<{ datasetReference: { datasetId: string } }>;
      nextPageToken?: string;
    };
    out.push(...(body.datasets ?? []).map((d) => d.datasetReference.datasetId));
    pageToken = body.nextPageToken;
  } while (pageToken);

  return out.sort();
}

export interface BqTableInfo {
  tableId: string;
  /** TABLE, VIEW, EXTERNAL or MATERIALIZED_VIEW — a view is not a table to load from. */
  type: string;
  rows: number | null;
  bytes: number | null;
  /** Last modified, ISO. The cheapest staleness signal a warehouse offers. */
  modifiedAt: string | null;
}

/**
 * Tables in a dataset, with row counts and sizes, and still no bytes scanned.
 *
 * `tables.list` returns metadata only. The alternative — `__TABLES__` — is a
 * query, and a browser that bills a scan every time somebody expands a dataset
 * is a browser nobody is allowed to use.
 */
export async function listTables(dataset: string, project = config.gcpProjectId): Promise<BqTableInfo[]> {
  const token = await getAccessToken();
  const out: BqTableInfo[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${BQ_BASE}/projects/${project}/datasets/${dataset}/tables`);
    url.searchParams.set('maxResults', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`BigQuery ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      tables?: Array<{
        tableReference: { tableId: string };
        type?: string;
        numRows?: string;
        numBytes?: string;
        lastModifiedTime?: string;
      }>;
      nextPageToken?: string;
    };
    for (const t of body.tables ?? []) {
      out.push({
        tableId: t.tableReference.tableId,
        type: t.type ?? 'TABLE',
        rows: t.numRows == null ? null : Number(t.numRows),
        bytes: t.numBytes == null ? null : Number(t.numBytes),
        modifiedAt: t.lastModifiedTime ? new Date(Number(t.lastModifiedTime)).toISOString() : null,
      });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);

  // `tables.list` returns names and types but not sizes — those live on
  // `tables.get`, which would be one request per table. `__TABLES__` is a free
  // metadata pseudo-table that carries all of them in a single query scanning
  // zero bytes. If it is unavailable the listing still works, without counts.
  try {
    const stats = await runQuery<{ table_id: string; row_count: number; size_bytes: number; last_modified_time: number }>({
      query: `SELECT table_id, row_count, size_bytes, last_modified_time FROM \`${project}.${dataset}.__TABLES__\``,
      connector: 'discovery',
    });
    const by = new Map(stats.rows.map((r) => [r.table_id, r]));
    for (const t of out) {
      const s = by.get(t.tableId);
      if (!s) continue;
      t.rows = Number(s.row_count);
      t.bytes = Number(s.size_bytes);
      t.modifiedAt = s.last_modified_time ? new Date(Number(s.last_modified_time)).toISOString() : null;
    }
  } catch {
    // Counts are a nicety; the list of tables is the thing.
  }

  return out;
}

export interface BqColumn {
  name: string;
  type: string;
  mode: string;
}

/** Columns for one table. Metadata only — again, no bytes scanned. */
export async function listColumns(
  dataset: string,
  table: string,
  project = config.gcpProjectId,
): Promise<BqColumn[]> {
  const token = await getAccessToken();
  const res = await fetch(
    `${BQ_BASE}/projects/${project}/datasets/${dataset}/tables/${encodeURIComponent(table)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`BigQuery ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    schema?: { fields?: Array<{ name: string; type: string; mode?: string }> };
  };
  return (body.schema?.fields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    mode: f.mode ?? 'NULLABLE',
  }));
}

export async function describeTable(
  dataset: string,
  table: string,
  project = config.gcpProjectId,
): Promise<Array<{ column_name: string; data_type: string }>> {
  const res = await runQuery<{ column_name: string; data_type: string }>({
    query: `
      SELECT column_name, data_type
      FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name = @table
      ORDER BY ordinal_position`,
    params: { table },
    connector: 'discovery',
  });
  return res.rows;
}

export async function tableExists(dataset: string, tablePrefix: string, project = config.gcpProjectId): Promise<boolean> {
  try {
    const res = await runQuery<{ n: number }>({
      query: `
        SELECT COUNT(*) AS n
        FROM \`${project}.${dataset}.INFORMATION_SCHEMA.TABLES\`
        WHERE table_name LIKE @prefix`,
      params: { prefix: `${tablePrefix}%` },
      connector: 'discovery',
    });
    return (res.rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}
