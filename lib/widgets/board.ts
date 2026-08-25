/**
 * §4.10 — assembling a board.
 *
 * Two properties this file exists to guarantee:
 *
 * **Only the needed modules run.** A board of four store tiles must not fetch
 * orders, the catalogue and GA4 as well. Each widget declares its module
 * through its metric or its series, and only those are awaited.
 *
 * **A widget that cannot be drawn says so.** Pointing at a metric that has been
 * renamed, or a series whose module failed, resolves to `unavailable` with a
 * sentence. It never resolves to zero. On a wall screen a zero and a missing
 * number look identical from across the room, and only one of them is news.
 */
import { getMetric } from '@/lib/metrics/registry';
import type { MetricValue } from '@/lib/metrics/compute';
import {
  appHealthModule,
  catalogueModule,
  issuesModule,
  journeyDiscoveryModule,
  journeyModule,
  salesModule,
  storesModule,
} from '@/lib/services/modules';
import { trailingWindow, type DateWindow } from '@/lib/format/dates';
import { getThresholds, type Thresholds } from '@/lib/db/settings';
import { getSeries, type BoardModules, type ModuleId } from './series';
import type { ResolvedWidget, WidgetSpec } from './types';

/**
 * Which module publishes each §5 metric.
 *
 * Derived once at module load by asking every module what it emits would mean
 * running all of them to draw one tile. The map is asserted against reality by
 * `widgets.test.ts`, which runs every module and checks each metric it emits
 * appears here — so a metric that moves house fails a test rather than a board.
 */
export const METRIC_MODULE: Record<string, ModuleId | 'journey'> = {
  orders: 'sales',
  orders_confirmed: 'sales',
  egmv: 'sales',
  net_revenue: 'sales',
  aov: 'sales',
  units_per_order: 'sales',
  discount_rate: 'sales',
  coupon_attach_rate: 'sales',
  new_customers: 'sales',
  repeat_rate: 'sales',
  revenue_mom: 'sales',

  scan_success_rate: 'journey',
  atc_rate: 'journey',
  checkout_rate: 'journey',
  payment_success_rate: 'journey',
  session_conversion: 'journey',
  time_to_order_p50: 'journey',

  journeys_discovered: 'discovered',
  journey_worst_exit_rate: 'discovered',
  journey_sessions_at_risk: 'discovered',
  journey_path_coverage: 'discovered',

  stores_live: 'stores',
  stores_active: 'stores',
  stores_dark: 'stores',
  store_activation_pct: 'stores',
  daily_order_compliance: 'stores',
  orders_per_active_store: 'stores',
  days_since_last_order: 'stores',

  unique_coverage: 'catalogue',
  total_coverage: 'catalogue',
  audited_coverage: 'catalogue',
  true_coverage: 'catalogue',
  missing_distinct: 'catalogue',
  missing_new: 'catalogue',
  missing_resolved: 'catalogue',
  missing_age_p50: 'catalogue',
  scan_rejection_rate: 'catalogue',
  store_coverage: 'catalogue',
  report_generated: 'catalogue',

  app_health_score: 'appHealth',
  crash_free_rate: 'appHealth',
  api_error_rate: 'appHealth',
  payment_failure_rate: 'appHealth',
  p95_latency: 'appHealth',
  error_log_volume: 'appHealth',
  release_adoption: 'appHealth',
  geofence_delivery_rate: 'appHealth',

  // `p0_open` is emitted by both /app-health and /issues. Issues wins: it is
  // that module's subject, and app-health carries it only as a score input.
  p0_open: 'issues',
  p0_age_p50: 'issues',
  issues_unowned: 'issues',
  open_close_ratio: 'issues',
};

/** Every metric a widget can be pointed at — the ones with a module behind them. */
export function boardableMetrics(): string[] {
  return Object.keys(METRIC_MODULE).filter((id) => getMetric(id));
}

function modulesNeeded(specs: WidgetSpec[]): Set<ModuleId | 'journey'> {
  const need = new Set<ModuleId | 'journey'>();
  for (const s of specs) {
    if (s.metricId) {
      const m = METRIC_MODULE[s.metricId];
      if (m) need.add(m);
    }
    if (s.seriesId) {
      const series = getSeries(s.seriesId);
      if (series) need.add(series.module);
    }
  }
  return need;
}

interface LoadedModules extends BoardModules {
  journey?: Awaited<ReturnType<typeof journeyModule>>;
}

async function loadModules(
  need: Set<ModuleId | 'journey'>,
  w: DateWindow,
): Promise<{ modules: LoadedModules; warnings: string[] }> {
  const entries = await Promise.all(
    [...need].map(async (id): Promise<[string, LoadedModules[keyof LoadedModules] | null]> => {
      try {
        switch (id) {
          case 'sales':
            return ['sales', await salesModule(w)];
          case 'stores':
            return ['stores', await storesModule(w)];
          case 'catalogue':
            return ['catalogue', await catalogueModule()];
          case 'appHealth':
            return ['appHealth', await appHealthModule(w)];
          case 'issues':
            return ['issues', await issuesModule()];
          case 'discovered':
            return ['discovered', await journeyDiscoveryModule(w)];
          case 'journey':
            return ['journey', await journeyModule(w)];
        }
      } catch {
        // One failed module must not blank the board. Its tiles say why; the
        // rest keep working, which is the difference between a degraded wall
        // display and a dark one.
        return [id, null];
      }
    }),
  );

  const modules: LoadedModules = {};
  const warnings: string[] = [];
  for (const [id, value] of entries) {
    if (value) (modules as Record<string, unknown>)[id] = value;
    else warnings.push(`${id} could not be loaded — its tiles will say so.`);
  }
  return { modules, warnings };
}

/**
 * The threshold a goal, gauge or status falls back to when the widget carries
 * no explicit target.
 *
 * Read from `app_setting`, so a target changed on /settings moves the board
 * with it. Two places disagreeing about what "good" means is how a green light
 * ends up on a wall above a number somebody else considers a breach.
 */
export function defaultTarget(metricId: string, t: Thresholds): number | null {
  switch (metricId) {
    case 'unique_coverage':
    case 'total_coverage':
    case 'audited_coverage':
    case 'true_coverage':
      return t.coverage_target;
    case 'crash_free_rate':
      return t.crash_free_target;
    case 'payment_success_rate':
      return t.payment_success_target;
    case 'api_error_rate':
      return t.api_error_ceiling;
    case 'payment_failure_rate':
      return 1 - t.payment_success_target;
    case 'p0_open':
      return t.p0_ceiling;
    default:
      // No invented default. A goal with no target draws a bar against a
      // ceiling nobody agreed to, and the tile says so instead.
      return null;
  }
}

export interface Board {
  widgets: ResolvedWidget[];
  window: DateWindow;
  warnings: string[];
  /** For the "as of" line. A board with no clock is a board nobody can trust. */
  builtAt: string;
}

export async function buildBoard(
  specs: WidgetSpec[],
  window: DateWindow = trailingWindow(28),
): Promise<Board> {
  const ordered = [...specs].sort((a, b) => a.order - b.order);
  const [{ modules, warnings }, thresholds] = await Promise.all([
    loadModules(modulesNeeded(ordered), window),
    getThresholds(),
  ]);

  const widgets = ordered.map<ResolvedWidget>((spec) => {
    if (spec.kind === 'text') {
      return { spec, title: spec.title ?? 'Note' };
    }

    if (spec.seriesId) {
      const def = getSeries(spec.seriesId);
      if (!def) {
        return {
          spec,
          title: spec.title ?? spec.seriesId,
          unavailable: `No series called "${spec.seriesId}" — it may have been renamed.`,
        };
      }
      const mod = (modules as Record<string, { state: MetricValue['state']; sources: string[] } | undefined>)[
        def.module
      ];
      if (!mod) {
        return { spec, title: spec.title ?? def.label, unavailable: `${def.module} could not be loaded.` };
      }
      const resolved = def.resolve(modules);
      return {
        spec,
        title: spec.title ?? def.label,
        series: {
          points: resolved.points,
          note: resolved.note,
          unit: def.unit,
          direction: def.direction,
          source: mod.sources[0] ?? def.module,
          state: mod.state,
        },
      };
    }

    if (spec.metricId) {
      const moduleId = METRIC_MODULE[spec.metricId];
      const mod = moduleId
        ? (modules as Record<string, { kpis: MetricValue[] } | undefined>)[moduleId]
        : undefined;
      const metric = mod?.kpis.find((k) => k.id === spec.metricId);
      if (!metric) {
        return {
          spec,
          title: spec.title ?? getMetric(spec.metricId)?.label ?? spec.metricId,
          unavailable: moduleId
            ? `${spec.metricId} is not being published by ${moduleId} right now.`
            : `No metric called "${spec.metricId}" in the §5 registry.`,
        };
      }
      return {
        spec: {
          ...spec,
          target: spec.target ?? defaultTarget(spec.metricId, thresholds),
        },
        title: spec.title ?? metric.label,
        metric,
      };
    }

    return { spec, title: spec.title ?? 'Widget', unavailable: 'This widget points at nothing.' };
  });

  return { widgets, window, warnings, builtAt: new Date().toISOString() };
}

/**
 * The board somebody sees before they have built one.
 *
 * Chosen to answer the §4.1 hub question — is Companion healthy today — rather
 * than to show off widget kinds. Every one of these is a P0 metric with a live
 * connector behind it.
 */
export const DEFAULT_BOARD: WidgetSpec[] = [
  { id: 'd1', kind: 'number', metricId: 'orders', size: 'sm', order: 1 },
  { id: 'd2', kind: 'number', metricId: 'net_revenue', size: 'sm', order: 2 },
  { id: 'd3', kind: 'gauge', metricId: 'scan_success_rate', size: 'sm', order: 3 },
  { id: 'd4', kind: 'goal', metricId: 'unique_coverage', size: 'sm', order: 4 },
  { id: 'd5', kind: 'trend', seriesId: 'sales.daily_revenue', size: 'md', order: 5 },
  { id: 'd6', kind: 'leaderboard', seriesId: 'stores.dark', size: 'md', order: 6 },
  { id: 'd8', kind: 'status', metricId: 'crash_free_rate', size: 'sm', order: 8 },
  { id: 'd9', kind: 'number', metricId: 'p0_open', size: 'sm', order: 9 },
  { id: 'd10', kind: 'leaderboard', seriesId: 'discovered.worst_journeys', size: 'md', order: 10 },
];
