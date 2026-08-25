/**
 * §30 — Connector build order and readiness.
 *
 * The critical path is #1 → #2 → #3 → #4: store master, catalogue report,
 * orders, GA4 events. Those four make the dashboard real; everything after is
 * depth.
 *
 * This registry backs `/connectors` (§4.9) — the page that makes the rest of the
 * dashboard trustworthy.
 */
import { minutesSince } from '@/lib/format/dates';
import { lastRunFor } from './run-log';
import type { ConnectorStatus } from './types';
import type { BaseConnector } from './base';

import { bqStoreMaster } from './bq-store-master';
import { slackCatalogueReport } from './slack-catalogue-report';
import { slackCatalogueSyncReport } from './slack-catalogue-sync-report';
import { bqOrders } from './bq-orders';
import { bqGa4Events } from './bq-ga4-events';
import { bqGa4Scans } from './bq-ga4-scans';
import { bqGa4Journeys } from './bq-ga4-journeys';
import { bqCatalogueMaster } from './bq-catalogue-master';
import { bqCatalogueHealth } from './bq-catalogue-health';
import { catalogueGapRegister } from './catalogue-gap-register';
import { sentry } from './sentry';
import { jira } from './jira';
import { ga4Api } from './ga4-api';
import { apiLatency } from './api-latency';
import { gcpLogging } from './gcp-logging';
import { slackAlerts } from './slack-alerts';
import { amplitude } from './amplitude';
import { testEanCanary } from './test-ean-canary';
import { bqLoyalty } from './bq-loyalty';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Build order from §30. The order here is the order shown on `/connectors`. */
export const CONNECTORS: BaseConnector<any, any>[] = [
  bqStoreMaster,
  slackCatalogueReport,
  // The defect half of the same hourly report. Separate because the grain
  // differs — one row a day versus one per (report, pipeline, error) — and one
  // connector is one row type.
  slackCatalogueSyncReport,
  bqOrders,
  bqGa4Events,
  // The scan half of the same GA4 export. Separate because the grain differs
  // and one connector is one row type; sharing would mean a `load()` that
  // branches on which half it was handed.
  bqGa4Scans,
  // The sequence half. `bq-ga4-events` throws the order away by aggregating per
  // event per day; this keeps whole session paths so a journey can be
  // discovered rather than declared (ADR-005).
  bqGa4Journeys,
  bqCatalogueMaster,
  // Catalogue *completeness* (attributes/media/on-platform) from the
  // sng-prod.catalogue_health summary tables — a different measurement from
  // scan-observed coverage, never blended with it (§16.5.2).
  bqCatalogueHealth,
  // Derived in Postgres from the two above — no credential of its own.
  catalogueGapRegister,
  sentry,
  jira,
  ga4Api,
  apiLatency,
  gcpLogging,
  slackAlerts,
  amplitude,
  testEanCanary,
  // ADR-001 — a deliberate departure from §0, gated behind MODULE_LOYALTY.
  bqLoyalty,
];
/* eslint-enable @typescript-eslint/no-explicit-any */

export function getConnector(id: string) {
  return CONNECTORS.find((c) => c.id === id);
}

export async function connectorStatuses(): Promise<ConnectorStatus[]> {
  return Promise.all(
    CONNECTORS.map(async (c) => {
      const d = c.descriptor();
      const run = await lastRunFor(c.id);
      const freshnessMinutes = run?.finishedAt ? minutesSince(run.finishedAt) : null;
      const withinSla = freshnessMinutes != null && freshnessMinutes <= d.freshnessSlaMinutes;

      // A run row still marked `running` after the stale threshold is an
      // invocation that was killed before it could write its outcome. Showing
      // it as live would be a permanent spinner; showing it as green would be a
      // lie. It is `abandoned`, and it is the reason a connector went stale.
      const running = run?.status === 'running';
      const abandoned = running && minutesSince(run!.startedAt) >= 10;

      // grey = never configured, so it is not a failure — it is a known blocker.
      const health: ConnectorStatus['health'] = !d.configured
        ? 'grey'
        // Seeded is loaded, but it is not live. Green here would mean the board
        // vouches for data that came out of a fixture file.
        : run?.seeded
          ? 'grey'
          : abandoned || run?.status === 'fail'
            ? 'red'
            : run?.status === 'warn' || (!withinSla && run != null)
              ? 'amber'
              : run?.status === 'success'
                ? 'green'
                : 'grey';

      return {
        ...d,
        lastRunAt: run?.finishedAt ?? run?.startedAt ?? null,
        lastStatus: (running
          ? abandoned
            ? 'fail'
            : 'warn'
          : (run?.status ?? 'never')) as ConnectorStatus['lastStatus'],
        rowsIngested: run?.rowsIngested ?? null,
        freshnessMinutes,
        withinSla,
        lastError:
          run?.error ??
          (abandoned
            ? `Run ${run!.runId} started ${Math.round(minutesSince(run!.startedAt))} min ago and never reported — the invocation was killed before it could finish.`
            : null),
        assertions: run?.assertions ?? [],
        health,
        running: running && !abandoned,
        seeded: run?.seeded ?? false,
        nextDueInMinutes:
          freshnessMinutes == null ? 0 : Math.max(0, Math.round(d.freshnessSlaMinutes - freshnessMinutes)),
      };
    }),
  );
}

/**
 * §4.9 — the lineage view: for each KPI, which connector produced it. Derived
 * from each connector's declared `powers` rather than maintained by hand, so it
 * cannot drift from the code.
 */
export function lineage(): Array<{ metricOrPage: string; connectors: string[] }> {
  const m = new Map<string, string[]>();
  for (const c of CONNECTORS) {
    for (const p of c.descriptor().powers) {
      const list = m.get(p) ?? [];
      list.push(c.id);
      m.set(p, list);
    }
  }
  return [...m.entries()]
    .map(([metricOrPage, connectors]) => ({ metricOrPage, connectors }))
    .sort((a, b) => a.metricOrPage.localeCompare(b.metricOrPage));
}
