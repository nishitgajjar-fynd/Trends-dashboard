'use client';

/**
 * §4.4 — where the stores are, and which of them have gone quiet.
 *
 * A plotted projection rather than a tile map. Tiles need a network round trip
 * per pan, an API key, and a third party who now knows which stores Reliance is
 * looking at; none of that buys anything here, because the question is "which
 * cluster is dark", not "which street is it on".
 *
 * Equirectangular, which is wrong as a projection and right for this: over
 * India's ~30° of latitude the distortion is a vertical stretch nobody reading
 * a cluster will misread. It is labelled as a scatter, not a map, so nobody
 * measures distance off it.
 *
 * Markers are cities, not stores. The first version drew one circle per store
 * and Companion's estate is ~13 stores per city inside a 0.14° radius, so 272
 * markers rendered as twenty blobs with the dark ones hidden underneath the
 * healthy ones — the exact question the map exists to answer, made invisible by
 * the rendering. Each marker is now sized by store count with the dark share
 * filled in, so a half-dark city looks half dark from across the room.
 *
 * A store with no coordinates is **listed underneath rather than dropped**:
 * silently plotting 340 of 350 stores would make the map a quietly wrong
 * denominator, and the ten missing are exactly the ones whose master data
 * nobody has filled in.
 */
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatCount, formatINR } from '@/lib/format/currency';

export interface StorePoint {
  storeId: string;
  storeCode: string;
  storeName: string;
  city: string;
  state: string;
  lat: number | null;
  lon: number | null;
  orders28d: number;
  revenue28d: number;
  isDark: boolean;
  daysSinceLastOrder: number | null;
}

const W = 720;
const H = 760;
const PAD = 24;

interface Cluster {
  city: string;
  state: string;
  stores: StorePoint[];
  lat: number;
  lon: number;
  dark: number;
  darkShare: number;
  orders: number;
  revenue: number;
}

export function StoreMap({ stores }: { stores: StorePoint[] }) {
  const [hover, setHover] = useState<Cluster | null>(null);

  const { plotted, missing, project } = useMemo(() => {
    // A coordinate of exactly 0,0 is the Atlantic, not a store in Gujarat — it
    // is the default a null became somewhere upstream, and plotting it would
    // put a phantom store off the coast of Africa.
    const plotted = stores.filter(
      (s) => s.lat != null && s.lon != null && Number.isFinite(s.lat) && Number.isFinite(s.lon) && !(s.lat === 0 && s.lon === 0),
    );
    const missing = stores.filter((s) => !plotted.includes(s));

    const lats = plotted.map((s) => s.lat as number);
    const lons = plotted.map((s) => s.lon as number);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const spanLat = maxLat - minLat || 1;
    const spanLon = maxLon - minLon || 1;

    const project = (s: StorePoint) => ({
      x: PAD + (((s.lon as number) - minLon) / spanLon) * (W - PAD * 2),
      // Latitude increases northward, y increases downward.
      y: PAD + (1 - ((s.lat as number) - minLat) / spanLat) * (H - PAD * 2),
    });

    return { plotted, missing, project };
  }, [stores]);

  /**
   * Clustered by city, not plotted per store.
   *
   * The first version drew one circle per store. Companion's estate is ~13
   * stores per city inside a 0.14° radius, so 272 markers rendered as twenty
   * blobs with the dark ones hidden underneath the healthy ones — the exact
   * question the map exists to answer, made invisible by the rendering.
   *
   * One marker per city: outer ring sized by store count, inner disc sized by
   * the share that are dark. A city that is half dark looks half dark from
   * across the room, which is the whole point.
   */
  const clusters = useMemo(() => {
    const byCity = new Map<string, { city: string; state: string; stores: StorePoint[]; lat: number; lon: number }>();
    for (const s of plotted) {
      const key = `${s.city}|${s.state}`;
      const e = byCity.get(key) ?? { city: s.city, state: s.state, stores: [], lat: 0, lon: 0 };
      e.stores.push(s);
      byCity.set(key, e);
    }
    return [...byCity.values()].map((c) => {
      // Centroid, so a marker sits among its stores rather than on one of them.
      c.lat = c.stores.reduce((a, s) => a + (s.lat as number), 0) / c.stores.length;
      c.lon = c.stores.reduce((a, s) => a + (s.lon as number), 0) / c.stores.length;
      const dark = c.stores.filter((s) => s.isDark).length;
      return {
        ...c,
        dark,
        darkShare: dark / c.stores.length,
        orders: c.stores.reduce((a, s) => a + s.orders28d, 0),
        revenue: c.stores.reduce((a, s) => a + s.revenue28d, 0),
      };
    });
  }, [plotted]);

  const maxStores = Math.max(1, ...clusters.map((c) => c.stores.length));
  const radius = (n: number) => 6 + Math.sqrt(n / maxStores) * 22;

  return (
    <figure data-store-map className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
      <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="label">Stores by location</span>
          <p className="mt-0.5 text-2xs text-[var(--text-muted)]">
            One marker per city, sized by store count, with the dark share filled in red. A scatter,
            not a map — do not measure distance off it.
          </p>
        </div>
        <div className="flex items-center gap-3 text-2xs text-[var(--text-muted)]">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full border border-[var(--color-scan)] bg-[var(--color-scan)]/20" aria-hidden />{' '}
            city, sized by stores
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-alert)]" aria-hidden /> share dark
          </span>
        </div>
      </figcaption>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={`${plotted.length} stores in ${clusters.length} cities, ${plotted.filter((s) => s.isDark).length} of them dark`}
        >
          {clusters.map((c) => {
            const { x, y } = project({ lat: c.lat, lon: c.lon } as StorePoint);
            const r = radius(c.stores.length);
            // Area, not radius, tracks the share — a radius proportional to
            // 30% would read as roughly 10%, because the eye reads area.
            const rDark = r * Math.sqrt(c.darkShare);
            const hot = c.darkShare >= 0.3;
            return (
              <g
                key={`${c.city}|${c.state}`}
                data-store-cluster={c.city}
                className="cursor-pointer"
                onMouseEnter={() => setHover(c)}
                onMouseLeave={() => setHover(null)}
              >
                <circle
                  cx={x}
                  cy={y}
                  r={r}
                  fill="var(--color-scan)"
                  fillOpacity={0.16}
                  stroke="var(--color-scan)"
                  strokeOpacity={0.55}
                  strokeWidth={hover?.city === c.city ? 2 : 1}
                />
                {c.dark > 0 && (
                  <circle cx={x} cy={y} r={rDark} fill="var(--color-alert)" fillOpacity={0.8} />
                )}
                {/* Named only where there is room, so the chart does not become
                    a word cloud. */}
                {r > 13 && (
                  <text
                    x={x}
                    y={y + r + 10}
                    textAnchor="middle"
                    fontSize="10"
                    fill={hot ? 'var(--color-alert)' : 'var(--color-muted)'}
                  >
                    {c.city}
                  </text>
                )}
                {/* Single string child: React 19 rejects a <title> with multiple
                    children, which fails hydration for the whole page (and with it
                    every filter control) once the map has markers to render. */}
                <title>{`${c.city} — ${c.stores.length} stores, ${c.dark} dark (${Math.round(c.darkShare * 100)}%)`}</title>
              </g>
            );
          })}
        </svg>

        {hover && (
          <div className="pointer-events-none absolute left-2 top-2 max-w-xs rounded border border-[var(--color-edge)] bg-[var(--color-ink)] p-2.5 text-2xs">
            <div className="text-[var(--text-primary)]">
              {hover.city}
              {hover.state ? `, ${hover.state}` : ''}
            </div>
            <div className="text-[var(--text-muted)]">
              <span className="num">{hover.stores.length}</span> stores ·{' '}
              <span className="num">{formatCount(hover.orders)}</span> orders ·{' '}
              <span className="num">{formatINR(hover.revenue)}</span>
            </div>
            {hover.dark > 0 && (
              <div className="mt-1 text-[var(--color-alert)]">
                {hover.dark} dark ({Math.round(hover.darkShare * 100)}%) —{' '}
                {hover.stores
                  .filter((s) => s.isDark)
                  .slice(0, 3)
                  .map((s) => s.storeName || s.storeCode)
                  .join(', ')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* The denominator, stated. A map quietly drawing 340 of 350 stores is a
          map that answers a different question from the one being asked. */}
      <p className="mt-3 text-2xs text-[var(--text-muted)]">
        {formatCount(plotted.length)} of {formatCount(stores.length)} stores, in {clusters.length} cities.
        {missing.length > 0 && (
          <>
            {' '}
            <span className="text-[var(--color-warn)]">
              {missing.length} have no usable coordinates
            </span>{' '}
            and are not on the chart:{' '}
            {missing
              .slice(0, 6)
              .map((s) => s.storeName || s.storeCode)
              .join(', ')}
            {missing.length > 6 && ` and ${missing.length - 6} more`}. Their master-data rows need lat
            and lon before they can appear here.
          </>
        )}
      </p>
    </figure>
  );
}

/** The dark cluster, if there is one — computed from the same points as the map. */
export function DarkClusterNote({ stores }: { stores: StorePoint[] }) {
  const byState = new Map<string, { dark: number; total: number }>();
  for (const s of stores) {
    const e = byState.get(s.state) ?? { dark: 0, total: 0 };
    e.total += 1;
    if (s.isDark) e.dark += 1;
    byState.set(s.state, e);
  }

  // Only states with enough stores for a rate to mean anything. Two of two dark
  // is 100% and is not a cluster.
  const ranked = [...byState.entries()]
    .filter(([, v]) => v.total >= 5 && v.dark > 0)
    .map(([state, v]) => ({ state, ...v, rate: v.dark / v.total }))
    .sort((a, b) => b.rate - a.rate);

  if (ranked.length === 0) return null;
  const worst = ranked[0];

  return (
    <p className={cn('text-2xs', worst.rate >= 0.3 ? 'text-[var(--color-alert)]' : 'text-[var(--text-muted)]')}>
      Darkest cluster: <span className="text-[var(--text-primary)]">{worst.state}</span> — {worst.dark} of{' '}
      {worst.total} stores ({Math.round(worst.rate * 100)}%). States with fewer than five stores are
      excluded, because one dark store out of two is not a cluster.
    </p>
  );
}
