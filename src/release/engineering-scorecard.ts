/**
 * Deterministic AMQUR engineering scorecard.
 * Displayed total MUST equal the sum of category scores.
 */

export const ENGINEERING_SCORECARD_MAX = {
  architecture: 8,
  sftpInventory: 14,
  aiTruthRouting: 15,
  crmAppointments: 12,
  widgetWebsite: 10,
  securityPrivacy: 15,
  testingEvaluation: 10,
  cicdMigrationsDeploy: 8,
  observabilityRecovery: 5,
  documentationHandoff: 3,
} as const;

export type EngineeringScoreCategory = keyof typeof ENGINEERING_SCORECARD_MAX;

export const ENGINEERING_SCORECARD_MAX_TOTAL = (
  Object.values(ENGINEERING_SCORECARD_MAX) as number[]
).reduce((a, b) => a + b, 0);

if (ENGINEERING_SCORECARD_MAX_TOTAL !== 100) {
  throw new Error(
    `scorecard_max_misconfigured: sum=${ENGINEERING_SCORECARD_MAX_TOTAL}`,
  );
}

export type EngineeringScorecard = {
  categories: Record<EngineeringScoreCategory, number>;
  total: number;
  maxTotal: number;
  asOf: string;
  notes?: Partial<Record<EngineeringScoreCategory, string>>;
};

export function buildEngineeringScorecard(
  categories: Record<EngineeringScoreCategory, number>,
  opts?: {
    asOf?: string;
    notes?: Partial<Record<EngineeringScoreCategory, string>>;
  },
): EngineeringScorecard {
  const out = {} as Record<EngineeringScoreCategory, number>;
  let total = 0;
  for (const key of Object.keys(
    ENGINEERING_SCORECARD_MAX,
  ) as EngineeringScoreCategory[]) {
    const max = ENGINEERING_SCORECARD_MAX[key];
    const raw = categories[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new Error(`scorecard_missing_or_invalid:${key}`);
    }
    if (!Number.isInteger(raw) || raw < 0 || raw > max) {
      throw new Error(`scorecard_out_of_range:${key}=${raw} max=${max}`);
    }
    out[key] = raw;
    total += raw;
  }
  return {
    categories: out,
    total,
    maxTotal: ENGINEERING_SCORECARD_MAX_TOTAL,
    asOf: opts?.asOf ?? new Date().toISOString().slice(0, 10),
    notes: opts?.notes,
  };
}

export function assertScorecardTotalMatches(
  categories: Record<EngineeringScoreCategory, number>,
  displayedTotal: number,
): EngineeringScorecard {
  const built = buildEngineeringScorecard(categories);
  if (displayedTotal !== built.total) {
    throw new Error(
      `scorecard_total_mismatch: displayed=${displayedTotal} sum=${built.total}`,
    );
  }
  return built;
}

/**
 * Checkpoint scores after Railway migration + inventory harden (1d01e9a+) + effect override.
 * Production launch readiness is separate and remains blocked on external gates.
 */
export function currentEngineeringCheckpoint(): EngineeringScorecard {
  return buildEngineeringScorecard(
    {
      architecture: 8,
      sftpInventory: 12,
      aiTruthRouting: 13,
      crmAppointments: 10,
      widgetWebsite: 8,
      securityPrivacy: 14,
      testingEvaluation: 8,
      cicdMigrationsDeploy: 8,
      observabilityRecovery: 4,
      documentationHandoff: 3,
    },
    {
      asOf: '2026-11-20',
      notes: {
        sftpInventory:
          'Live auth+dirs EMPTY; validation/txn/health shipped; files still waiting (−2).',
        aiTruthRouting: 'Staging LLM key missing (−2).',
        crmAppointments: 'Live ADF/Tekion external (−2).',
        widgetWebsite: 'Embed gated; manual a11y pending (−2).',
        securityPrivacy:
          'effect override clears Prisma high advisories; host-key authoritative attestation still owner (−1).',
        testingEvaluation: 'Live-model holdout blocked (−2).',
        cicdMigrationsDeploy:
          'CI green on HEAD; staging API+worker SHA aligned. Main Actions RAILWAY_API_TOKEN still owner-verify after migration.',
        observabilityRecovery:
          'Ops alert path implemented; OPS_ALERT_WEBHOOK_URL unset on worker (−1).',
      },
    },
  );
}
