import {
  ENGINEERING_SCORECARD_MAX,
  ENGINEERING_SCORECARD_MAX_TOTAL,
  assertScorecardTotalMatches,
  buildEngineeringScorecard,
  currentEngineeringCheckpoint,
} from './engineering-scorecard';

describe('engineering-scorecard', () => {
  it('max categories sum to exactly 100', () => {
    expect(ENGINEERING_SCORECARD_MAX_TOTAL).toBe(100);
    expect(
      Object.values(ENGINEERING_SCORECARD_MAX).reduce((a, b) => a + b, 0),
    ).toBe(100);
  });

  it('total always equals the sum of categories', () => {
    const categories = {
      architecture: 8,
      sftpInventory: 12,
      aiTruthRouting: 13,
      crmAppointments: 10,
      widgetWebsite: 8,
      securityPrivacy: 14,
      testingEvaluation: 8,
      cicdMigrationsDeploy: 7,
      observabilityRecovery: 4,
      documentationHandoff: 3,
    };
    const sum = Object.values(categories).reduce((a, b) => a + b, 0);
    const built = buildEngineeringScorecard(categories);
    expect(built.total).toBe(sum);
    expect(built.total).toBe(87);
    expect(assertScorecardTotalMatches(categories, 87).total).toBe(87);
  });

  it('rejects the prior reporting bug (displayed 91 vs sum 85)', () => {
    const categories = {
      architecture: 8,
      sftpInventory: 12,
      aiTruthRouting: 13,
      crmAppointments: 10,
      widgetWebsite: 8,
      securityPrivacy: 12,
      testingEvaluation: 8,
      cicdMigrationsDeploy: 7,
      observabilityRecovery: 4,
      documentationHandoff: 3,
    };
    expect(Object.values(categories).reduce((a, b) => a + b, 0)).toBe(85);
    expect(() => assertScorecardTotalMatches(categories, 91)).toThrow(
      /scorecard_total_mismatch/,
    );
  });

  it('current checkpoint total matches its category sum', () => {
    const sc = currentEngineeringCheckpoint();
    const sum = Object.values(sc.categories).reduce((a, b) => a + b, 0);
    expect(sc.total).toBe(sum);
    expect(sc.maxTotal).toBe(100);
    expect(sc.total).toBeLessThanOrEqual(100);
  });
});
