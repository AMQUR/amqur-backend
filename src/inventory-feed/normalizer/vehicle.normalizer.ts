type NormalizedVehicle = {
  vin: string;
  stock?: string;

  year: number;
  make: string;
  model: string;
  trim?: string;

  bodyType?: string;
  drivetrain?: string;
  transmission?: string;
  fuelType?: string;
  color?: string;

  price?: number;
  msrp?: number;
  mileage?: number;

  photos?: string[];
};

function cleanString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function parseIntSafe(v: unknown): number | undefined {
  const s = cleanString(v);
  if (!s) return undefined;

  const cleaned = s.replace(/[$,\s]/g, '');
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : undefined;
}

function pick(raw: any, keys: string[]): unknown {
  for (const key of keys) {
    const value = raw?.[key];
    if (cleanString(value) !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizePhotos(raw: any): string[] | undefined {
  if (Array.isArray(raw?.photos)) {
    const urls = raw.photos
      .map((p: any) => cleanString(p))
      .filter((p): p is string => Boolean(p));
    return urls.length ? urls : undefined;
  }

  const single = cleanString(raw?.photo);
  if (single) return [single];

  const images = raw?.images?.image ?? raw?.images;
  if (Array.isArray(images)) {
    const urls = images
      .map((i: any) => cleanString(i?.url ?? i?.href ?? i))
      .filter((p): p is string => Boolean(p));
    return urls.length ? urls : undefined;
  }

  const alt = cleanString(raw?.imageUrl ?? raw?.image_url ?? raw?.image);
  if (alt) return [alt];

  return undefined;
}

export class VehicleNormalizer {
  static normalize(raw: any): NormalizedVehicle | null {
    const vin = cleanString(
      pick(raw, ['vin', 'VIN', 'Vin', 'vehicleVIN', 'vehicle_vin']),
    );
    if (!vin) return null;

    const year = parseIntSafe(
      pick(raw, ['year', 'Year', 'modelYear', 'model_year']),
    );
    const make = cleanString(pick(raw, ['make', 'Make']));
    const model = cleanString(pick(raw, ['model', 'Model']));

    // Required by Prisma schema
    if (!year || year < 1900 || year > 2100) return null;
    if (!make) return null;
    if (!model) return null;

    return {
      vin,
      stock: cleanString(
        pick(raw, ['stock', 'StockNumber', 'stockNumber', 'stock_number']),
      ),

      year,
      make,
      model,
      trim: cleanString(pick(raw, ['trim', 'Trim'])),

      bodyType: cleanString(pick(raw, ['bodyType', 'body_type', 'BodyType'])),
      drivetrain: cleanString(
        pick(raw, ['drivetrain', 'driveTrain', 'DriveTrain']),
      ),
      transmission: cleanString(pick(raw, ['transmission', 'Transmission'])),
      fuelType: cleanString(pick(raw, ['fuelType', 'fuel_type', 'FuelType'])),
      color: cleanString(
        pick(raw, ['color', 'Color', 'exteriorColor', 'exterior_color']),
      ),

      price: parseIntSafe(
        pick(raw, ['price', 'Price', 'salePrice', 'sale_price']),
      ),
      msrp: parseIntSafe(pick(raw, ['msrp', 'MSRP'])),
      mileage: parseIntSafe(
        pick(raw, ['mileage', 'Miles', 'odometer', 'Odometer']),
      ),

      photos: normalizePhotos(raw),
    };
  }
}
