/**
 * §5.4b — Connector: `bq-catalogue-health` (catalogue completeness).
 *
 * Reads the Geckoboard-style summary tables in `sng-prod.catalogue_health` — the
 * completeness/quality view of the catalogue (attributes filled, images present,
 * on platform), which is a different measurement from scan-observed coverage and
 * is never blended with it (§16.5.2).
 *
 * The three source tables are tiny (a few rows each), already aggregated per
 * pipeline (OVERALL / SAP / AJIO CE), so this connector just reads the latest
 * snapshot and reshapes it into one row per pipeline. Source percentages are
 * 0–100; they are stored as 0–1 ratios to render like every other §5 ratio.
 */
import { range } from '@/lib/assertions';
import { config } from '@/lib/config';
import { fixtureCatalogueHealth, type CatalogueHealthRow } from '@/fixtures/catalogue-health';
import { isBigQueryConfigured, runQuery } from '@/lib/gcp/bigquery';
import type { DateWindow } from '@/lib/format/dates';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

const DS = () => config.bqCatalogueHealthDataset;

interface SummaryRow {
  pipeline: string;
  total_catalog: number;
  complete_catalog: number;
  missing_catalog: number;
  completion_percentage: number;
  fill_rate_percentage: number;
  media_coverage_percentage: number;
  snapshot_time: string;
}
interface AttrRow {
  pipeline: string;
  attribute_name: string;
  fill_rate_percentage: number;
  missing_count: number;
}
interface QualityRow {
  metric_name: string;
  metric_value: number;
}

const pct = (v: unknown): number => Math.max(0, Math.min(1, Number(v ?? 0) / 100));

export class BqCatalogueHealthConnector extends BaseConnector<CatalogueHealthRow, CatalogueHealthRow> {
  readonly id = 'bq-catalogue-health';
  readonly displayName = 'BigQuery — catalogue completeness';
  readonly freshnessSlaMinutes = 26 * 60;
  readonly costTier: CostTier = 'metered';
  readonly priority = 'P1' as const;
  readonly powers = [
    '/catalogue',
    'catalogue_completion',
    'catalogue_fill_rate',
    'catalogue_media_coverage',
    'catalogue_missing_records',
  ];

  isConfigured(): boolean {
    return isBigQueryConfigured();
  }

  protected async extract(): Promise<CatalogueHealthRow[]> {
    const ds = DS();
    const [summary, attrs, quality] = await Promise.all([
      runQuery<SummaryRow>({
        query: `SELECT pipeline, total_catalog, complete_catalog, missing_catalog,
                       completion_percentage, fill_rate_percentage, media_coverage_percentage, snapshot_time
                FROM \`${ds}.geckoboard_summary_v2\`
                WHERE snapshot_time = (SELECT MAX(snapshot_time) FROM \`${ds}.geckoboard_summary_v2\`)`,
        connector: this.id,
      }),
      runQuery<AttrRow>({
        query: `SELECT pipeline, attribute_name, fill_rate_percentage, missing_count
                FROM \`${ds}.attribute_fill_rate_v2\`
                WHERE snapshot_time = (SELECT MAX(snapshot_time) FROM \`${ds}.attribute_fill_rate_v2\`)`,
        connector: this.id,
      }),
      runQuery<QualityRow>({
        query: `SELECT metric_name, metric_value
                FROM \`${ds}.catalog_quality_summary_v2\`
                WHERE snapshot_time = (SELECT MAX(snapshot_time) FROM \`${ds}.catalog_quality_summary_v2\`)`,
        connector: this.id,
      }),
    ]);

    const attrsByPipeline = new Map<string, CatalogueHealthRow['attributes']>();
    for (const a of attrs.rows) {
      const list = attrsByPipeline.get(a.pipeline) ?? [];
      list.push({
        attribute: a.attribute_name,
        fillRate: pct(a.fill_rate_percentage),
        missing: Number(a.missing_count ?? 0),
      });
      attrsByPipeline.set(a.pipeline, list);
    }
    const qualityList = quality.rows.map((q) => ({ metric: q.metric_name, value: Number(q.metric_value ?? 0) }));

    return summary.rows.map((s) => {
      const snapshotAt = s.snapshot_time ?? null;
      return {
        snapshotDate: snapshotAt ? snapshotAt.slice(0, 10) : new Date().toISOString().slice(0, 10),
        pipeline: s.pipeline,
        totalCatalog: Number(s.total_catalog ?? 0),
        completeCatalog: Number(s.complete_catalog ?? 0),
        missingCatalog: Number(s.missing_catalog ?? 0),
        completionPct: pct(s.completion_percentage),
        fillRatePct: pct(s.fill_rate_percentage),
        mediaCoveragePct: pct(s.media_coverage_percentage),
        attributes: (attrsByPipeline.get(s.pipeline) ?? []).sort((a, b) => a.fillRate - b.fillRate),
        // Quality issues are catalogue-wide, so attach them to OVERALL only.
        quality: s.pipeline === 'OVERALL' ? qualityList : [],
        snapshotAt,
      };
    });
  }

  protected transform(rows: CatalogueHealthRow[]): CatalogueHealthRow[] {
    return rows;
  }

  protected async load(rows: CatalogueHealthRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factCatalogueHealth } = await import('@/lib/db/schema');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_catalogue_health' };
    for (const r of rows) {
      await db
        .insert(factCatalogueHealth)
        .values({
          snapshotDate: r.snapshotDate,
          pipeline: r.pipeline,
          totalCatalog: r.totalCatalog,
          completeCatalog: r.completeCatalog,
          missingCatalog: r.missingCatalog,
          completionPct: String(r.completionPct),
          fillRatePct: String(r.fillRatePct),
          mediaCoveragePct: String(r.mediaCoveragePct),
          attributes: r.attributes,
          quality: r.quality,
          snapshotAt: r.snapshotAt ? new Date(r.snapshotAt) : null,
          source: this.id,
        })
        .onConflictDoUpdate({
          target: [factCatalogueHealth.snapshotDate, factCatalogueHealth.pipeline],
          set: {
            totalCatalog: r.totalCatalog,
            completeCatalog: r.completeCatalog,
            missingCatalog: r.missingCatalog,
            completionPct: String(r.completionPct),
            fillRatePct: String(r.fillRatePct),
            mediaCoveragePct: String(r.mediaCoveragePct),
            attributes: r.attributes,
            quality: r.quality,
            snapshotAt: r.snapshotAt ? new Date(r.snapshotAt) : null,
          },
        });
    }
    return { rowsIngested: rows.length, table: 'fact_catalogue_health' };
  }

  fixture(_w: DateWindow): CatalogueHealthRow[] {
    return fixtureCatalogueHealth();
  }

  readonly assertions: Assertion<CatalogueHealthRow>[] = [
    range<CatalogueHealthRow>({ column: 'completionPct', min: 0, max: 1, level: 'fail' }),
    range<CatalogueHealthRow>({ column: 'mediaCoveragePct', min: 0, max: 1, level: 'warn' }),
  ];
}

export const bqCatalogueHealth = new BqCatalogueHealthConnector();
