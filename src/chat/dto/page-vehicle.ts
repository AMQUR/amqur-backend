/**
 * The vehicle listing published on the page the customer has open (schema.org Vehicle data the
 * dealer's own website exposes). It is reported by the browser, so it is untrusted input:
 * anything that is not a short plain value in range is DROPPED (never rejected, so a strange
 * page can never break the chat request). No price, no description, no free text.
 */
export type PageVehicle = {
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  condition?: 'new' | 'used' | 'certified';
  mileage?: number;
  color?: string;
  bodyType?: string;
  fuelType?: string;
};

const TEXT = /^[\p{L}\p{N} .,&'()/+-]{1,60}$/u;

const text = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return TEXT.test(t) ? t : undefined;
};

const int = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = typeof v === 'string' && /^\d{1,7}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi
    ? n
    : undefined;
};

export function sanitizePageVehicle(value: unknown): PageVehicle | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const o = value as Record<string, unknown>;
  const condition =
    o.condition === 'new' ||
    o.condition === 'used' ||
    o.condition === 'certified'
      ? o.condition
      : undefined;
  const out: PageVehicle = {
    year: int(o.year, 1980, 2100),
    make: text(o.make),
    model: text(o.model),
    trim: text(o.trim),
    condition,
    mileage: int(o.mileage, 0, 1_000_000),
    color: text(o.color),
    bodyType: text(o.bodyType),
    fuelType: text(o.fuelType),
  };
  for (const k of Object.keys(out) as Array<keyof PageVehicle>)
    if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

/** A page path only: no host, query or fragment. Anything else is dropped. */
export function sanitizePagePath(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^\/(?!\/)[A-Za-z0-9/_.~+%-]{0,199}$/.test(value)
    ? value
    : undefined;
}
