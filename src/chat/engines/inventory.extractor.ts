/* ─────────────────────────────────────────────
   Inventory Extractor — FINAL
───────────────────────────────────────────── */

export type InventoryPatch = {
  query?: string;
  year?: number;
  maxPrice?: number;
  maxMonthlyPayment?: number;
  color?: string;
  drivetrain?: string;
  bodyType?: string;
  sortBy?: 'price_asc' | 'price_desc';
};

export type InventoryUpdate = {
  patch: InventoryPatch;
  remove: (keyof InventoryPatch)[];
  resetAll: boolean;
};

export class InventoryExtractor {
  static extract(text: string): InventoryUpdate {
    const msg = text.toLowerCase();

    const resetAll = /start over|reset|clear|new search|forget/.test(msg);

    const remove: (keyof InventoryPatch)[] = [];

    if (/any color|all colors/.test(msg)) remove.push('color');
    if (/any price|no budget|remove price/.test(msg)) remove.push('maxPrice');
    if (/any year|no year limit/.test(msg)) remove.push('year');

    // ───── year ─────
    const yearMatch = msg.match(/\b(20[0-2][0-9])\b/);
    const year = yearMatch ? Number(yearMatch[1]) : undefined;

    // ───── price ─────
    const priceMatch = msg.match(
      /\b(under|below|less than)\s*\$?\s*(\d{2,6})(k)?\b/,
    );

    let maxPrice: number | undefined;

    if (priceMatch) {
      const raw = Number(priceMatch[2]);
      maxPrice = priceMatch[3] ? raw * 1000 : raw;
    }

    // ───── color ─────
    const colors = ['black', 'white', 'silver', 'gray', 'red', 'blue'];
    const color = colors.find((c) => msg.includes(c));

    // ───── drivetrain ─────
    let drivetrain: string | undefined;
    if (msg.includes('4x4') || msg.includes('four wheel')) drivetrain = '4x4';
    if (msg.includes('awd')) drivetrain = 'AWD';
    if (msg.includes('fwd')) drivetrain = 'FWD';
    if (msg.includes('rwd')) drivetrain = 'RWD';

    // ───── body type ─────
    let bodyType: string | undefined;
    if (msg.includes('suv')) bodyType = 'SUV';
    if (msg.includes('truck')) bodyType = 'Truck';
    if (msg.includes('sedan')) bodyType = 'Sedan';

    // ───── sorting ─────
    let sortBy: 'price_asc' | 'price_desc' | undefined;
    if (msg.includes('cheapest')) sortBy = 'price_asc';
    if (msg.includes('most expensive')) sortBy = 'price_desc';

    // ───── cleaned query ─────
    const cleaned = msg
      .replace(/\b(under|below|less than)\s*\$?\s*\d{2,6}k?\b/g, '')
      .replace(/\b(cheapest|only|just|show me)\b/g, '')
      .trim();

    const patch: InventoryPatch = {
      query: undefined,
      year,
      maxPrice,
      color,
      drivetrain,
      bodyType,
      sortBy,
    };

    if (cleaned && !/only|under|color|price|door|awd|fwd|rwd/.test(cleaned)) {
      patch.query = cleaned;
    }

    return {
      patch,
      remove,
      resetAll,
    };
  }

  /* ─────────────────────────────────────────────
       Helper: flatten update → state patch
       (prevents TypeScript errors)
    ───────────────────────────────────────────── */

  static toStatePatch(update: InventoryUpdate): Partial<InventoryPatch> {
    if (update.resetAll) {
      return {};
    }

    const result: Partial<InventoryPatch> = {
      ...update.patch,
    };

    for (const key of update.remove) {
      delete (result as any)[key];
    }

    return result;
  }
}
