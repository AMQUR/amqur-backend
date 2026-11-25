import {
  ComplianceInput,
  DEFAULT_POLICY,
  evaluateCompliance,
  nextWindowOpen,
  timezoneForPhone,
  sanitizePolicy,
} from './compliance.engine';
import { EffectiveControl } from './controls';

const OPEN: EffectiveControl = {
  processEnabled: true,
  halted: false,
  haltedBy: [],
  mode: 'SUPERVISED',
  externalSendAllowed: true,
  externalSendBlocks: [],
  workflowAuthorization: null,
};
const APPROVED = {
  ...DEFAULT_POLICY,
  legalApproval: {
    approvedBy: 'counsel',
    approvedAt: '2026-11-01',
    documentRef: 'L-1',
  },
};
// 2026-11-18 16:00 UTC = 10:00 America/Chicago
const NOW = new Date('2026-11-18T16:00:00Z');

const base = (p: Partial<ComplianceInput> = {}): ComplianceInput => ({
  now: NOW,
  workflowKey: 'first_response',
  channel: 'SMS',
  endpoint: '+13125550100',
  control: OPEN,
  policy: APPROVED,
  consent: {
    allowed: true,
    grantId: 'g1',
    grantedAt: '2026-11-17T00:00:00Z',
    purpose: 'CONVERSATIONAL',
  },
  suppressions: [],
  crmDoNotContact: false,
  timezone: 'America/Chicago',
  timezoneSource: 'customer',
  sentToday: 0,
  sentThisWeek: 0,
  unansweredAttempts: 0,
  lastInboundAt: null,
  lastOutboundAt: null,
  humanOwnsConversation: false,
  leadPaused: false,
  conflictingOpenAction: false,
  leadSource: 'website',
  senderIdentityApproved: true,
  channelCapabilityVerified: true,
  ...p,
});
const rules = (i: ComplianceInput) =>
  evaluateCompliance(i).blocks.map((b) => b.rule);

describe('compliance engine', () => {
  it('allows a send only when every rule passes', () => {
    const d = evaluateCompliance(base());
    expect(d.sendAllowed).toBe(true);
    expect(d.blocks).toEqual([]);
  });

  it('a phone number without a consent record is not consent', () => {
    const d = evaluateCompliance(
      base({ consent: { allowed: false, reason: 'no_consent' } }),
    );
    expect(d.sendAllowed).toBe(false);
    expect(d.draftAllowed).toBe(false);
    expect(d.routeForReview).toBe(true);
  });

  it('opt-out blocks sending and drafting', () => {
    const d = evaluateCompliance(
      base({ consent: { allowed: false, reason: 'opted_out' } }),
    );
    expect(d.sendAllowed).toBe(false);
    expect(d.draftAllowed).toBe(false);
  });

  it('an SMS opt-out is not worked around by email when the suppression is ALL', () => {
    const d = evaluateCompliance(
      base({
        channel: 'EMAIL',
        endpoint: 'a@example.invalid',
        suppressions: [{ channel: 'ALL', reason: 'DO_NOT_CONTACT' }],
      }),
    );
    expect(d.blocks.map((b) => b.rule)).toContain('suppressed');
    expect(d.draftAllowed).toBe(false);
  });

  it('a channel suppression blocks that channel', () => {
    expect(
      rules(base({ suppressions: [{ channel: 'SMS', reason: 'STOP' }] })),
    ).toContain('suppressed');
    expect(
      rules(
        base({
          channel: 'EMAIL',
          endpoint: 'a@example.invalid',
          suppressions: [{ channel: 'SMS', reason: 'STOP' }],
        }),
      ),
    ).not.toContain('suppressed');
  });

  it('CRM do-not-contact preference blocks', () => {
    expect(rules(base({ crmDoNotContact: true }))).toContain(
      'crm_do_not_contact',
    );
  });

  it('human takeover and lead pause block sending and drafting', () => {
    for (const p of [{ humanOwnsConversation: true }, { leadPaused: true }]) {
      const d = evaluateCompliance(base(p));
      expect(d.sendAllowed).toBe(false);
      expect(d.draftAllowed).toBe(false);
    }
  });

  it('a kill switch blocks sending and drafting', () => {
    const d = evaluateCompliance(
      base({
        control: {
          ...OPEN,
          halted: true,
          haltedBy: ['GLOBAL'],
          externalSendAllowed: false,
          externalSendBlocks: ['halted'],
        },
      }),
    );
    expect(d.blocks[0].rule).toBe('halted');
    expect(d.draftAllowed).toBe(false);
  });

  it('outbound outside the contact window is deferred, in the customer timezone', () => {
    // 03:00 UTC = 21:00 Chicago (previous day)
    const d = evaluateCompliance(
      base({ now: new Date('2026-11-18T03:00:00Z') }),
    );
    expect(d.blocks.map((b) => b.rule)).toContain('outside_contact_window');
    expect(d.deferUntil).toBe('2026-11-18T15:00:00.000Z'); // 09:00 Chicago
    expect(d.draftAllowed).toBe(true);
    // Same instant is 19:00 in Los Angeles — inside the window there.
    expect(
      rules(
        base({
          now: new Date('2026-11-18T03:00:00Z'),
          timezone: 'America/Los_Angeles',
        }),
      ),
    ).not.toContain('outside_contact_window');
  });

  it('replying to a customer who just wrote is not held by the outbound window or caps', () => {
    const d = evaluateCompliance(
      base({
        workflowKey: 'reply_inbound',
        now: new Date('2026-11-18T03:00:00Z'),
        lastInboundAt: new Date('2026-11-18T02:59:00Z'),
        sentToday: 9,
        sentThisWeek: 9,
      }),
    );
    expect(d.sendAllowed).toBe(true);
  });

  it('an inbound-reply workflow needs an unanswered inbound message', () => {
    expect(
      rules(
        base({
          workflowKey: 'reply_inbound',
          lastInboundAt: new Date('2026-11-17T10:00:00Z'),
          lastOutboundAt: new Date('2026-11-17T11:00:00Z'),
        }),
      ),
    ).toContain('no_unanswered_inbound');
  });

  it('frequency caps and attempt limits stop outbound', () => {
    expect(rules(base({ sentToday: 2 }))).toContain('frequency_day');
    expect(rules(base({ sentThisWeek: 4 }))).toContain('frequency_week');
    const d = evaluateCompliance(base({ unansweredAttempts: 3 }));
    expect(d.blocks.map((b) => b.rule)).toContain('max_unanswered_attempts');
    expect(d.draftAllowed).toBe(false);
  });

  it('marketing needs a current MARKETING grant; a conversational grant or an old record is not enough', () => {
    expect(rules(base({ workflowKey: 'recovery_reactivation' }))).toContain(
      'consent_purpose_mismatch',
    );
    expect(
      rules(
        base({
          workflowKey: 'recovery_reactivation',
          consent: {
            allowed: true,
            grantId: 'g',
            grantedAt: '2024-01-01T00:00:00Z',
            purpose: 'MARKETING',
          },
        }),
      ),
    ).toContain('consent_stale');
    expect(
      evaluateCompliance(
        base({
          workflowKey: 'recovery_reactivation',
          consent: {
            allowed: true,
            grantId: 'g',
            grantedAt: '2026-10-01T00:00:00Z',
            purpose: 'MARKETING',
          },
        }),
      ).sendAllowed,
    ).toBe(true);
  });

  it('restricted lead sources, unapproved senders, unverified channels and unapproved policy block sends', () => {
    expect(
      rules(
        base({
          policy: { ...APPROVED, restrictedLeadSources: ['thirdparty-x'] },
          leadSource: 'ThirdParty-X',
        }),
      ),
    ).toContain('lead_source_restricted');
    expect(rules(base({ senderIdentityApproved: false }))).toContain(
      'sender_identity_not_approved',
    );
    expect(rules(base({ channelCapabilityVerified: false }))).toContain(
      'channel_capability_not_verified',
    );
    expect(rules(base({ policy: DEFAULT_POLICY }))).toContain(
      'policy_not_legally_approved',
    );
  });

  it('duplicate / conflicting open action blocks', () => {
    const d = evaluateCompliance(base({ conflictingOpenAction: true }));
    expect(d.sendAllowed).toBe(false);
    expect(d.draftAllowed).toBe(false);
  });

  it('unknown timezone fails closed', () => {
    expect(rules(base({ timezone: 'Not/AZone' }))).toContain(
      'timezone_unknown',
    );
  });

  it('maps known area codes and returns null for unknown ones', () => {
    expect(timezoneForPhone('+13125550100')).toBe('America/Chicago');
    expect(timezoneForPhone('+12135550100')).toBe('America/Los_Angeles');
    expect(timezoneForPhone('+19995550100')).toBeNull();
    expect(
      nextWindowOpen(
        new Date('2026-11-18T16:00:00Z'),
        'America/Chicago',
        9 * 60,
      ),
    ).toBe('2026-11-19T15:00:00.000Z');
  });

  describe('stored policy is validated, never trusted', () => {
    const approval = {
      approvedBy: 'counsel',
      approvedAt: '2026-11-01',
      documentRef: 'L-1',
    };
    it('never takes legal approval from the policy body itself', () => {
      const p = sanitizePolicy({ legalApproval: approval, version: 'v2' });
      expect(p.legalApproval).toBeNull();
      expect(sanitizePolicy({ version: 'v2' }, approval).legalApproval).toEqual(
        approval,
      );
      expect(
        sanitizePolicy(
          {},
          { approvedBy: '', approvedAt: 'x', documentRef: 'y' },
        ).legalApproval,
      ).toBeNull();
    });
    it('falls back per field instead of removing a limit', () => {
      const p = sanitizePolicy({
        contactWindow: { startMin: 1200, endMin: 60 },
        maxPerDay: { MARKETING: 9999, CONVERSATIONAL: 'lots' },
        maxPerWeek: { TRANSACTIONAL: Infinity },
        maxUnansweredAttempts: -1,
        marketingConsentMaxAgeDays: Number.NaN,
        restrictedLeadSources: ['  Cars-X  ', 7],
      });
      expect(p.contactWindow).toEqual(DEFAULT_POLICY.contactWindow);
      expect(p.maxPerDay).toEqual(DEFAULT_POLICY.maxPerDay);
      expect(p.maxPerWeek).toEqual(DEFAULT_POLICY.maxPerWeek);
      expect(p.maxUnansweredAttempts).toBe(
        DEFAULT_POLICY.maxUnansweredAttempts,
      );
      expect(p.marketingConsentMaxAgeDays).toBe(
        DEFAULT_POLICY.marketingConsentMaxAgeDays,
      );
      expect(p.restrictedLeadSources).toEqual(['cars-x']);
    });
    it('accepts valid bounded values and tolerates junk input', () => {
      const p = sanitizePolicy({
        contactWindow: { startMin: 600, endMin: 1080 },
        maxPerDay: { MARKETING: 0 },
      });
      expect(p.contactWindow).toEqual({ startMin: 600, endMin: 1080 });
      expect(p.maxPerDay.MARKETING).toBe(0);
      expect(sanitizePolicy(null)).toMatchObject({
        legalApproval: null,
        version: DEFAULT_POLICY.version,
      });
      expect(sanitizePolicy('x' as unknown)).toMatchObject({
        maxPerDay: DEFAULT_POLICY.maxPerDay,
      });
    });
  });
});
