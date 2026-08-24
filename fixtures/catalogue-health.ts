/**
 * §5.4b — fixture for catalogue completeness (the `catalogue_health` dataset).
 *
 * Numbers are realistic — modelled on the shape of the real snapshot (SAP is a
 * huge, sparsely-filled master; AJIO CE is small and nearly complete) — so the
 * completeness view is demoable before the connector is credentialed. Everything
 * served from here renders with the §14.5 fixture marker.
 */
export interface CatalogueHealthAttribute {
  attribute: string;
  fillRate: number; // 0–1
  missing: number;
}
export interface CatalogueHealthQuality {
  metric: string;
  value: number;
}
export interface CatalogueHealthRow {
  snapshotDate: string;
  pipeline: string; // OVERALL | SAP | AJIO CE
  totalCatalog: number;
  completeCatalog: number;
  missingCatalog: number;
  completionPct: number; // 0–1
  fillRatePct: number; // 0–1
  mediaCoveragePct: number; // 0–1
  attributes: CatalogueHealthAttribute[];
  quality: CatalogueHealthQuality[];
  snapshotAt: string | null;
}

export function fixtureCatalogueHealth(): CatalogueHealthRow[] {
  const day = new Date(Date.now() - 3 * 86_400_000);
  const snapshotDate = day.toISOString().slice(0, 10);
  const snapshotAt = day.toISOString();
  const attrs = (scale: number): CatalogueHealthAttribute[] => [
    { attribute: 'Description', fillRate: 0.0, missing: Math.round(15_432_000 * scale) },
    { attribute: 'Color', fillRate: 0.017, missing: Math.round(15_163_000 * scale) },
    { attribute: 'Pattern', fillRate: 0.234, missing: Math.round(11_821_000 * scale) },
    { attribute: 'Fabric', fillRate: 0.24, missing: Math.round(11_722_000 * scale) },
    { attribute: 'Primary Image', fillRate: 0.283, missing: Math.round(11_060_000 * scale) },
    { attribute: 'MRP', fillRate: 0.468, missing: Math.round(8_218_000 * scale) },
  ];
  const quality: CatalogueHealthQuality[] = [
    { metric: 'Missing Images', value: 11_453_984 },
    { metric: 'Missing Description', value: 15_432_087 },
    { metric: 'Duplicate EAN', value: 31_537 },
    { metric: 'Invalid Price', value: 386 },
  ];
  return [
    {
      snapshotDate,
      pipeline: 'OVERALL',
      totalCatalog: 15_432_134,
      completeCatalog: 4_390_321,
      missingCatalog: 11_041_813,
      completionPct: 0.2845,
      fillRatePct: 0.4,
      mediaCoveragePct: 0.2578,
      attributes: attrs(1),
      quality,
      snapshotAt,
    },
    {
      snapshotDate,
      pipeline: 'SAP',
      totalCatalog: 15_431_249,
      completeCatalog: 4_389_436,
      missingCatalog: 11_041_813,
      completionPct: 0.2845,
      fillRatePct: 0.4,
      mediaCoveragePct: 0.2577,
      attributes: attrs(1),
      quality: [],
      snapshotAt,
    },
    {
      snapshotDate,
      pipeline: 'AJIO CE',
      totalCatalog: 1_704_111,
      completeCatalog: 1_696_931,
      missingCatalog: 7_180,
      completionPct: 0.9958,
      fillRatePct: 0.6548,
      mediaCoveragePct: 0.9791,
      attributes: attrs(0.11),
      quality: [],
      snapshotAt,
    },
  ];
}
