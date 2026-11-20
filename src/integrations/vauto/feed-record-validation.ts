/**
 * Dial Difference / vAuto feed record guards.
 * Does not invent schema — only enforces VIN/stock hygiene and duplicate detection
 * that any inventory feed must satisfy before upsert.
 */

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
const STOCK_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;

/** Columns that may carry VIN in CSV/object feeds (case-insensitive match on keys). */
export const VIN_HEADER_ALIASES = [
  'vin',
  'vehiclevin',
  'vehicle_vin',
] as const;

export type FeedVehicleCandidate = {
  vin: string;
  stock?: string | null;
};

export type FeedValidationResult = {
  accepted: FeedVehicleCandidate[];
  anomalies: string[];
  rejectedCount: number;
  duplicateVinCount: number;
  invalidVinCount: number;
  invalidStockCount: number;
};

export function isPlausibleVin(vin: string): boolean {
  return VIN_RE.test(vin.trim());
}

export function isPlausibleStock(stock: string | undefined | null): boolean {
  if (stock == null) return true;
  const s = String(stock).trim();
  if (!s) return true;
  return STOCK_RE.test(s);
}

/** True when object keys include a VIN-bearing header (CSV/JSON row shape). */
export function rawRecordsHaveVinHeader(
  records: Array<Record<string, unknown>>,
): boolean {
  if (!records.length) return false;
  const keys = Object.keys(records[0] ?? {}).map((k) =>
    k.toLowerCase().replace(/[\s-]/g, ''),
  );
  return VIN_HEADER_ALIASES.some((alias) =>
    keys.includes(alias.replace(/_/g, '')),
  );
}

/**
 * Deduplicate by VIN (first wins), drop invalid VIN/stock shapes, collect anomalies.
 * Duplicate VINs in one snapshot are an anomaly (preserve last-known-good upstream).
 */
export function validateNormalizedFeedVehicles(
  vehicles: FeedVehicleCandidate[],
): FeedValidationResult {
  const anomalies: string[] = [];
  const seen = new Map<string, FeedVehicleCandidate>();
  let duplicateVinCount = 0;
  let invalidVinCount = 0;
  let invalidStockCount = 0;

  for (const v of vehicles) {
    const vin = String(v.vin ?? '')
      .toUpperCase()
      .trim();
    if (!isPlausibleVin(vin)) {
      invalidVinCount += 1;
      continue;
    }
    if (!isPlausibleStock(v.stock)) {
      invalidStockCount += 1;
      continue;
    }
    if (seen.has(vin)) {
      duplicateVinCount += 1;
      continue;
    }
    seen.set(vin, { ...v, vin, stock: v.stock?.trim() || undefined });
  }

  if (invalidVinCount)
    anomalies.push(`invalid_vin_count:${invalidVinCount}`);
  if (invalidStockCount)
    anomalies.push(`invalid_stock_count:${invalidStockCount}`);
  if (duplicateVinCount)
    anomalies.push(`duplicate_vin_in_feed:${duplicateVinCount}`);

  return {
    accepted: [...seen.values()],
    anomalies,
    rejectedCount: invalidVinCount + invalidStockCount + duplicateVinCount,
    duplicateVinCount,
    invalidVinCount,
    invalidStockCount,
  };
}

/** Hard reject when duplicates or schema-breaking issues are present. */
export function shouldRejectFeedValidation(
  result: FeedValidationResult,
  opts?: { requireVinHeader?: boolean; hasVinHeader?: boolean },
): string[] {
  const hard: string[] = [];
  if (result.duplicateVinCount > 0) {
    hard.push(
      result.anomalies.find((a) => a.startsWith('duplicate_vin_in_feed')) ??
        'duplicate_vin_in_feed',
    );
  }
  if (opts?.requireVinHeader && opts.hasVinHeader === false) {
    hard.push('schema_missing_vin_header');
  }
  return hard;
}
