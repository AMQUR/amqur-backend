import {
  REVIEW_REQUEST_INTENT_ACTION,
  REVIEW_REQUEST_INTENT_NOTES,
  ReviewRequestIntentService,
} from './review-request-intent.service';

describe('ReviewRequestIntentService', () => {
  const prisma = {
    customerSurvey: { findFirst: jest.fn() },
    conversation: { findFirst: jest.fn() },
    lead: { findFirst: jest.fn() },
    auditLog: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    analyticsEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const consent = { status: jest.fn() };
  const messaging = { previewConsent: jest.fn(), queue: jest.fn() };

  const svc = new ReviewRequestIntentService(
    prisma as never,
    consent as never,
    messaging as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.auditLog.create.mockResolvedValue({
      id: 'intent-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    prisma.auditLog.update.mockResolvedValue({});
  });

  it('checks SMS marketing consent and lead suppression without sending', async () => {
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      phone: '+15551234567',
      email: null,
      optOutAt: new Date(),
      locationId: 'loc-1',
      conversationId: null,
    });
    messaging.previewConsent.mockResolvedValue({ allowed: true });

    const result = await svc.checkEligibility({
      tenantId: 't1',
      leadId: 'lead-1',
      channel: 'SMS',
    });

    expect(result.eligible).toBe(false);
    expect(result.blockedReasons).toContain('lead_suppressed');
    expect(result.willSend).toBe(false);
    expect(result.notes).toEqual(REVIEW_REQUEST_INTENT_NOTES);
    expect(messaging.queue).not.toHaveBeenCalled();
  });

  it('does not use CSI survey score for eligibility', async () => {
    prisma.customerSurvey.findFirst.mockResolvedValue({
      id: 'survey-1',
      leadId: 'lead-1',
      conversationId: null,
      locationId: 'loc-1',
      score: 10,
    });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      phone: '+15559876543',
      email: null,
      optOutAt: null,
      locationId: 'loc-1',
      conversationId: null,
    });
    messaging.previewConsent.mockResolvedValue({ allowed: false, reason: 'no_consent' });

    const result = await svc.checkEligibility({
      tenantId: 't1',
      surveyId: 'survey-1',
    });

    expect(result.blockedReasons).toContain('no_consent');
    expect(result.eligible).toBe(false);
    expect(prisma.customerSurvey.findFirst).toHaveBeenCalled();
  });

  it('creates PENDING audit intent and analytics event without queueing SMS', async () => {
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      phone: '+15551234567',
      email: null,
      optOutAt: null,
      locationId: 'loc-1',
      conversationId: 'conv-1',
    });
    messaging.previewConsent.mockResolvedValue({ allowed: true });

    const created = await svc.createPendingIntent({
      tenantId: 't1',
      leadId: 'lead-1',
      createdByUserId: 'user-1',
    });

    expect(created.status).toBe('PENDING');
    expect(created.willSend).toBe(false);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: REVIEW_REQUEST_INTENT_ACTION,
          resource: 'ReviewRequestIntent',
        }),
      }),
    );
    expect(prisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'review_request.intent_pending',
        }),
      }),
    );
    expect(messaging.queue).not.toHaveBeenCalled();
    expect(created.id).toBe('intent-1');
  });

  it('lists pending intents from audit log', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a1',
        resourceId: 'a1',
        userId: 'u1',
        createdAt: new Date(),
        metadata: {
          status: 'PENDING',
          locationId: 'loc-1',
          leadId: 'lead-1',
          conversationId: null,
          surveyId: null,
          channel: 'SMS',
          maskedEndpoint: '***4567',
          eligible: true,
          blockedReasons: [],
        },
      },
    ]);

    const rows = await svc.listIntents('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].willSend).toBe(false);
  });
});
