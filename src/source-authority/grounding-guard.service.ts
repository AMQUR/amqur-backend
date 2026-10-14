import { Injectable } from '@nestjs/common';

export const ClaimType = {
  INVENTORY_AVAILABILITY: 'inventory_availability',
  PRICE: 'price',
  INCENTIVES: 'incentives',
  HOURS: 'hours',
  STAFF: 'staff',
  APPOINTMENT_CONFIRMATION: 'appointment_confirmation',
  SERVICE_STATUS: 'service_status',
  PARTS_FITMENT: 'parts_fitment',
  PARTS_STOCK: 'parts_stock',
  PARTS_PRICE: 'parts_price',
  FINANCE_APR: 'finance_apr',
  FINANCE_APPROVAL: 'finance_approval',
  POLICIES: 'policies',
} as const;

export type ClaimType = (typeof ClaimType)[keyof typeof ClaimType];

export type VerifiedFact = {
  claimType: ClaimType;
  /** When true, matching claim patterns in reply are allowed. */
  verified: boolean;
};

const SAFE_FALLBACKS: Record<ClaimType, string> = {
  [ClaimType.INVENTORY_AVAILABILITY]:
    'I cannot confirm current availability without checking our live inventory system.',
  [ClaimType.PRICE]:
    'I cannot confirm an exact price without verifying it against our current inventory feed.',
  [ClaimType.INCENTIVES]:
    'Incentive details vary — our team can confirm current offers that apply to you.',
  [ClaimType.HOURS]:
    'I do not have verified store hours for this location right now.',
  [ClaimType.STAFF]:
    'I cannot confirm specific staff availability without checking with the dealership.',
  [ClaimType.APPOINTMENT_CONFIRMATION]:
    'Your appointment request is noted, but I cannot confirm the slot until staff or our calendar system verifies it.',
  [ClaimType.SERVICE_STATUS]:
    'I cannot confirm repair or service order status without a verified system lookup.',
  [ClaimType.PARTS_FITMENT]:
    'I cannot confirm part fitment until our parts team verifies it for your vehicle.',
  [ClaimType.PARTS_STOCK]:
    'I cannot confirm parts stock without a verified parts system lookup.',
  [ClaimType.PARTS_PRICE]:
    'I cannot quote a parts price until our parts team verifies it.',
  [ClaimType.FINANCE_APR]:
    'APR and rate details depend on credit and lender programs — I cannot state a specific APR without verified information.',
  [ClaimType.FINANCE_APPROVAL]:
    'I cannot confirm financing approval — that requires a verified lender or finance team review.',
  [ClaimType.POLICIES]:
    'For official dealership policies, please refer to verified policy documents or ask our team to confirm.',
};

type ClaimPattern = { claimType: ClaimType; pattern: RegExp };

/** More specific claim types first so "parts … in stock" is not swallowed by vehicle inventory. */
const CLAIM_PATTERNS: ClaimPattern[] = [
  {
    claimType: ClaimType.PARTS_FITMENT,
    pattern:
      /\b(fits your|will fit|compatible with your|correct part for|this part works)\b/i,
  },
  {
    claimType: ClaimType.PARTS_STOCK,
    pattern:
      /\b(part(?:s)? (?:in|are in) stock|parts? are in stock|we have (?:the|that) part|part(?:s)? available)\b/i,
  },
  {
    claimType: ClaimType.PARTS_PRICE,
    pattern:
      /\b(part(?:s)? (?:cost|price|is \$)|\$[\d,]+ (?:for (?:the|that) part))\b/i,
  },
  {
    claimType: ClaimType.FINANCE_APR,
    pattern:
      /\b(\d+(?:\.\d+)?\s*%\s*(?:apr|interest)|apr (?:is|of) \d|approved at \d+(?:\.\d+)?\s*%)\b/i,
  },
  {
    claimType: ClaimType.FINANCE_APPROVAL,
    pattern:
      /\b(you(?:'re| are) (?:pre-)?approved|financing approved|credit approved|loan approved)\b/i,
  },
  {
    claimType: ClaimType.APPOINTMENT_CONFIRMATION,
    pattern:
      /\b(appointment (?:is )?confirmed|you(?:'re| are) (?:all )?set for|see you (?:on|at)|booked for|scheduled for \d)\b/i,
  },
  {
    claimType: ClaimType.SERVICE_STATUS,
    pattern:
      /\b(repair (?:is )?(?:done|complete|ready)|vehicle (?:is )?ready|service (?:is )?finished|work order (?:is )?closed|status:?\s*(?:complete|ready))\b/i,
  },
  {
    claimType: ClaimType.INCENTIVES,
    pattern:
      /\b(rebate|incentive|cash back|special offer|manufacturer (?:offer|bonus)|\$\d+\s*(?:off|rebate))\b/i,
  },
  {
    claimType: ClaimType.HOURS,
    pattern:
      /\b(open (?:at|from|until|till)|closed on|hours (?:are|is)|we(?:'re| are) open|store hours)\b/i,
  },
  {
    claimType: ClaimType.STAFF,
    pattern:
      /\b(salesperson|advisor|manager|technician|rep named|speak with \w+|your consultant is)\b/i,
  },
  {
    claimType: ClaimType.POLICIES,
    pattern:
      /\b(our policy (?:is|requires)|we always|guaranteed (?:return|warranty)|lifetime warranty|no questions asked)\b/i,
  },
  {
    claimType: ClaimType.PRICE,
    pattern:
      /\b(\$[\d,]+(?:\.\d{2})?|\d[\d,]*\s*dollars?|priced at|your price is|total (?:price|cost) (?:is|of))\b/i,
  },
  {
    claimType: ClaimType.INVENTORY_AVAILABILITY,
    pattern:
      /\b(in stock|available now|we have (?:one|this|that|a)|still available|on the lot|ready for (?:pickup|delivery))\b/i,
  },
];

/** Prompt-injection-like price claims embedded in assistant text. */
const INJECTION_PRICE_PATTERN =
  /\b(ignore (?:previous|all)|system prompt|disregard (?:instructions|rules))[\s\S]{0,80}\$[\d,]+/i;

/**
 * Claim types present in a SERVER-AUTHORED draft. Those were produced from tool evidence,
 * so the polish step may keep them; only claims the LLM *adds* are stripped.
 */
export function detectClaimTypes(text: string): ClaimType[] {
  const out: ClaimType[] = [];
  for (const { claimType, pattern } of CLAIM_PATTERNS) {
    if (pattern.test(text) && !out.includes(claimType)) out.push(claimType);
  }
  if (/\$\d/.test(text) && !out.includes(ClaimType.PRICE))
    out.push(ClaimType.PRICE);
  return out;
}

@Injectable()
export class GroundingGuardService {
  sanitizeCustomerReply(params: {
    reply: string;
    allowedClaimTypes?: ClaimType[];
    verifiedFacts: VerifiedFact[];
  }): { reply: string; sanitized: boolean; strippedClaimTypes: ClaimType[] } {
    let reply = params.reply;
    const allowed = new Set(params.allowedClaimTypes ?? []);
    const verifiedMap = new Map(
      params.verifiedFacts.map((f) => [f.claimType, f.verified]),
    );
    const strippedClaimTypes: ClaimType[] = [];
    let sanitized = false;

    if (INJECTION_PRICE_PATTERN.test(reply)) {
      reply = reply.replace(
        INJECTION_PRICE_PATTERN,
        SAFE_FALLBACKS[ClaimType.PRICE],
      );
      strippedClaimTypes.push(ClaimType.PRICE);
      sanitized = true;
    }

    for (const { claimType, pattern } of CLAIM_PATTERNS) {
      if (allowed.has(claimType)) continue;
      const isVerified = verifiedMap.get(claimType) === true;
      if (isVerified) continue;
      if (pattern.test(reply)) {
        reply = reply.replace(pattern, SAFE_FALLBACKS[claimType]);
        if (!strippedClaimTypes.includes(claimType)) {
          strippedClaimTypes.push(claimType);
        }
        sanitized = true;
      }
    }

    // Residual cleanup: pattern replace can leave orphaned dollar amounts / "approved"
    // after nearby claim fragments were rewritten.
    const priceOk =
      allowed.has(ClaimType.PRICE) || verifiedMap.get(ClaimType.PRICE) === true;
    if (!priceOk && /\$\d/.test(reply)) {
      reply = reply.replace(
        /\$[\d,]+(?:\.\d{2})?/g,
        SAFE_FALLBACKS[ClaimType.PRICE],
      );
      if (!strippedClaimTypes.includes(ClaimType.PRICE)) {
        strippedClaimTypes.push(ClaimType.PRICE);
      }
      sanitized = true;
    }

    const approvalOk =
      allowed.has(ClaimType.FINANCE_APPROVAL) ||
      verifiedMap.get(ClaimType.FINANCE_APPROVAL) === true;
    if (!approvalOk && /\b(?:pre-?)?approved\b/i.test(reply)) {
      reply = reply.replace(
        /\b(?:pre-?)?approved\b/gi,
        SAFE_FALLBACKS[ClaimType.FINANCE_APPROVAL],
      );
      if (!strippedClaimTypes.includes(ClaimType.FINANCE_APPROVAL)) {
        strippedClaimTypes.push(ClaimType.FINANCE_APPROVAL);
      }
      sanitized = true;
    }

    return { reply, sanitized, strippedClaimTypes };
  }
}
