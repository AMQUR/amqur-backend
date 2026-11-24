/**
 * Deterministic arithmetic for the conversation lane. The model decides WHEN to calculate;
 * the numbers come from here. No eval, no globals: a small recursive-descent parser.
 */

const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  sqrt: (x) => Math.sqrt(x),
  abs: (x) => Math.abs(x),
  round: (x, d = 0) => {
    const f = 10 ** Math.max(0, Math.min(10, Math.trunc(d)));
    return Math.round((x + Number.EPSILON) * f) / f;
  },
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  ln: (x) => Math.log(x),
  log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
  exp: (x) => Math.exp(x),
  pow: (x, y) => x ** y,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function evaluateExpression(input: string): number {
  // "$42,500" → 42500; "17%" → (17/100); "×" "÷" → * /
  const src = String(input ?? '')
    .slice(0, 400)
    .replace(/[$€£]/g, '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[×✕]/g, '*')
    .replace(/(?<=[\d)%])\s*x\s*(?=[\d(.])/gi, '*')
    .replace(/÷/g, '/')
    .replace(/\bof\b/gi, '*')
    .replace(/\s+/g, '');
  let i = 0;
  const peek = () => src[i];
  const fail = (): never => {
    throw new Error(`cannot parse expression near position ${i}`);
  };

  function expr(): number {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = src[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function term(): number {
    let v = unary();
    while (peek() === '*' || peek() === '/') {
      const op = src[i++];
      const r = unary();
      if (op === '/' && r === 0) throw new Error('division by zero');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function unary(): number {
    if (peek() === '-') {
      i += 1;
      return -unary();
    }
    if (peek() === '+') {
      i += 1;
      return unary();
    }
    return power();
  }
  function power(): number {
    const b = postfix();
    if (peek() === '^' || (peek() === '*' && src[i + 1] === '*')) {
      i += peek() === '^' ? 1 : 2;
      return b ** unary();
    }
    return b;
  }
  function postfix(): number {
    let v = primary();
    while (peek() === '%') {
      i += 1;
      v /= 100;
    }
    return v;
  }
  function primary(): number {
    const c = peek();
    if (c === '(') {
      i += 1;
      const v = expr();
      if (peek() !== ')') fail();
      i += 1;
      return v;
    }
    const num = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?|^\.\d+/i.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const id = /^[a-z]+/i.exec(src.slice(i));
    if (id) {
      const name = id[0].toLowerCase();
      i += id[0].length;
      if (peek() === '(') {
        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(`unknown function ${name}`);
        i += 1;
        const args: number[] = [];
        if (peek() !== ')') {
          args.push(expr());
          while (peek() === ',') {
            i += 1;
            args.push(expr());
          }
        }
        if (peek() !== ')') fail();
        i += 1;
        return fn(...args);
      }
      if (name in CONSTANTS) return CONSTANTS[name];
      throw new Error(`unknown name ${name}`);
    }
    return fail();
  }

  if (!src) throw new Error('empty expression');
  const out = expr();
  if (i !== src.length) fail();
  if (!Number.isFinite(out)) throw new Error('result is not a finite number');
  return out;
}

/** Up to 10 significant decimals, no float noise, no exponent for ordinary values. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(10)));
}

export type LoanInput = {
  price: number;
  annualRatePercent: number;
  termMonths: number;
  downPayment?: number;
  tradeInValue?: number;
  salesTaxPercent?: number;
  fees?: number;
};

export type LoanResult = {
  amountFinanced: number;
  monthlyPayment: number;
  totalOfPayments: number;
  totalInterest: number;
  salesTax: number;
};

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Standard fully-amortizing loan. Illustrative arithmetic on the caller's own assumptions —
 * never a quote. Tax (when given) is applied to price minus trade-in, the common US treatment;
 * the reply must say so.
 */
export function loanPayment(input: LoanInput): LoanResult {
  const price = Number(input.price);
  const rate = Number(input.annualRatePercent);
  const n = Math.trunc(Number(input.termMonths));
  const down = Number(input.downPayment ?? 0);
  const trade = Number(input.tradeInValue ?? 0);
  const taxPct = Number(input.salesTaxPercent ?? 0);
  const fees = Number(input.fees ?? 0);
  for (const [k, v] of Object.entries({
    price,
    rate,
    down,
    trade,
    taxPct,
    fees,
  }))
    if (!Number.isFinite(v) || v < 0)
      throw new Error(`${k} must be a non-negative number`);
  if (!(price > 0)) throw new Error('price must be greater than 0');
  if (!(n >= 1 && n <= 120))
    throw new Error('termMonths must be between 1 and 120');
  if (rate > 60) throw new Error('annualRatePercent looks wrong (over 60)');
  const salesTax = cents(Math.max(0, price - trade) * (taxPct / 100));
  const amountFinanced = cents(price + salesTax + fees - down - trade);
  if (amountFinanced <= 0)
    return {
      amountFinanced: 0,
      monthlyPayment: 0,
      totalOfPayments: 0,
      totalInterest: 0,
      salesTax,
    };
  const r = rate / 100 / 12;
  const monthly =
    r === 0 ? amountFinanced / n : (amountFinanced * r) / (1 - (1 + r) ** -n);
  const monthlyPayment = cents(monthly);
  const totalOfPayments = cents(monthlyPayment * n);
  return {
    amountFinanced,
    monthlyPayment,
    totalOfPayments,
    totalInterest: cents(totalOfPayments - amountFinanced),
    salesTax,
  };
}
