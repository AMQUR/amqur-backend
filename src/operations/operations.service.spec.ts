import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OperationsService } from './operations.service';

function makeOperationsService(
  prisma: Record<string, unknown>,
  extras?: { inventory?: { browseForStaff: jest.Mock } },
): OperationsService {
  const deps = [
    prisma,
    {},
    {},
    {},
    {},
    {},
    extras?.inventory ?? {},
  ] as unknown as ConstructorParameters<typeof OperationsService>;
  return new OperationsService(...deps);
}

describe('OperationsService.satisfaction', () => {
  const prisma = {
    analyticsEvent: { count: jest.fn().mockResolvedValue(4) },
  };

  let svc: OperationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = makeOperationsService(prisma);
    jest.spyOn(svc, 'overview').mockResolvedValue({
      window: '7d',
      attention: { openHandoffs: 2 },
      aiQuality: {
        replyFeedback: {
          total: 8,
          good: 6,
          goodRate: 0.75,
          neededHuman: 1,
          tooLong: 0,
          robotic: 0,
          wrongFacts: 0,
          wrongQuestion: 0,
          unnecessaryRapport: 0,
          byLabel: {},
        },
        inventoryMisses: 0,
        knowledgeMisses: 0,
      },
    } as Awaited<ReturnType<OperationsService['overview']>>);
  });

  it('returns available:false with proxy signals (no CSAT score)', async () => {
    jest.spyOn(svc as never, 'surveyProviderConnected').mockReturnValue(false);
    const r = await svc.satisfaction({ tenantId: 'tenant-1', locationId: null });
    expect(r.available).toBe(false);
    expect(
      (r as { reason?: string }).reason,
    ).toBe('survey_provider_not_connected');
    expect(r.signals.replyFeedback).toEqual({
      total: 8,
      good: 6,
      goodRate: 0.75,
      neededHuman: 1,
    });
    expect(r.signals.handoffs).toEqual({
      openEscalations: 2,
      handoffRequested7d: 4,
    });
    expect(prisma.analyticsEvent.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventType: 'handoff_requested' }),
      }),
    );
  });

  it('surfaces internal CSAT when CustomerSurvey responses exist', async () => {
    jest.spyOn(svc as never, 'surveyProviderConnected').mockReturnValue(true);
    const prismaWithSurvey = {
      ...prisma,
      customerSurvey: {
        findMany: jest.fn().mockResolvedValue([
          { score: 9, kind: 'SALES' },
          { score: 7, kind: 'SERVICE' },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const svc2 = makeOperationsService(prismaWithSurvey);
    jest.spyOn(svc2, 'overview').mockResolvedValue({
      window: '7d',
      attention: { openHandoffs: 2 },
      aiQuality: {
        replyFeedback: {
          total: 8,
          good: 6,
          goodRate: 0.75,
          neededHuman: 1,
          tooLong: 0,
          robotic: 0,
          wrongFacts: 0,
          wrongQuestion: 0,
          unnecessaryRapport: 0,
          byLabel: {},
        },
        inventoryMisses: 0,
        knowledgeMisses: 0,
      },
    } as Awaited<ReturnType<OperationsService['overview']>>);
    jest.spyOn(svc2 as never, 'surveyProviderConnected').mockReturnValue(true);

    const r = await svc2.satisfaction({ tenantId: 'tenant-1', locationId: null });
    expect(r.available).toBe(true);
    expect((r as { csat?: { average: number; count: number } }).csat).toEqual({
      average: 8,
      count: 2,
      scale: '1-10',
    });
    expect(
      (r as { byKind?: Record<string, { average: number; count: number }> })
        .byKind,
    ).toEqual({
      SALES: { average: 9, count: 1 },
      SERVICE: { average: 7, count: 1 },
    });
  });
});

describe('OperationsService.staffReply and note', () => {
  const scope = { tenantId: 'tenant-1', locationId: 'loc-1' };
  const conversationId = 'conv-1';
  const userId = 'user-staff';

  const prisma = {
    conversation: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    user: { findUnique: jest.fn() },
    message: { create: jest.fn() },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  let svc: OperationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.auditLog.create.mockResolvedValue({});
    svc = makeOperationsService(prisma);
    prisma.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      aiPaused: true,
      assignedUserId: userId,
    });
    prisma.user.findUnique.mockResolvedValue({ firstName: 'Alex' });
    prisma.message.create.mockImplementation(async ({ data }) => ({
      id: 'msg-1',
      ...data,
    }));
  });

  it('staffReply writes conversation.staff_reply audit log', async () => {
    const msg = await svc.staffReply(
      scope,
      conversationId,
      userId,
      'We can order that part today.',
    );

    expect(msg.id).toBe('msg-1');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: scope.tenantId,
        userId,
        action: 'conversation.staff_reply',
        resource: 'Conversation',
        resourceId: conversationId,
        metadata: { messageId: 'msg-1', chars: 29 },
      },
    });
  });

  it('staffReply rejects when conversation is not taken over', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      aiPaused: false,
      assignedUserId: null,
    });

    await expect(
      svc.staffReply(scope, conversationId, userId, 'Hello'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('note writes conversation.note audit log', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: conversationId });
    prisma.message.create.mockResolvedValue({ id: 'note-1' });

    const row = await svc.note(
      scope,
      conversationId,
      userId,
      'Customer prefers OEM only.',
    );

    expect(row.id).toBe('note-1');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: scope.tenantId,
        userId,
        action: 'conversation.note',
        resource: 'Conversation',
        resourceId: conversationId,
        metadata: { messageId: 'note-1' },
      },
    });
  });

  it('note throws when conversation is missing', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);

    await expect(
      svc.note(scope, conversationId, userId, 'Internal'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('OperationsService.takeover', () => {
  const scope = { tenantId: 'tenant-1', locationId: 'loc-1' };
  const conversationId = 'conv-1';
  const ownerId = 'user-owner';
  const otherStaffId = 'user-other';

  const prisma = {
    conversation: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    message: { create: jest.fn().mockResolvedValue({}) },
    escalation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    lead: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  let svc: OperationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = makeOperationsService(prisma);
  });

  it('throws ConflictException when another staff member already owns an active takeover', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      aiPaused: true,
      assignedUserId: ownerId,
    });

    await expect(
      svc.takeover(scope, conversationId, otherStaffId),
    ).rejects.toMatchObject({
      response: {
        message: 'Another team member owns this conversation — transfer it first',
        statusCode: 409,
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('assigns ownership and writes conversation.takeover audit when unclaimed', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      aiPaused: false,
      assignedUserId: null,
    });

    const result = await svc.takeover(scope, conversationId, ownerId);

    expect(result).toEqual({ ok: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: conversationId },
      data: {
        aiPaused: true,
        handoffState: 'JOINED',
        assignedUserId: ownerId,
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: scope.tenantId,
        userId: ownerId,
        action: 'conversation.takeover',
        resource: 'Conversation',
        resourceId: conversationId,
      },
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { conversationId },
      data: { assignedUserId: ownerId },
    });
  });
});

describe('OperationsService.transfer', () => {
  const scope = { tenantId: 'tenant-1', locationId: 'loc-1' };
  const conversationId = 'conv-1';
  const ownerId = 'user-owner';
  const otherStaffId = 'user-other';
  const managerId = 'user-manager';

  const prisma = {
    conversation: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    user: { findFirst: jest.fn() },
    message: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    lead: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  let svc: OperationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = makeOperationsService(prisma);
    prisma.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      locationId: 'loc-1',
      aiPaused: true,
      assignedUserId: ownerId,
    });
    prisma.user.findFirst.mockResolvedValue({
      id: otherStaffId,
      firstName: 'Jordan',
      lastName: 'Lee',
    });
  });

  it('reassigns ownership when the current owner transfers', async () => {
    const result = await svc.transfer(
      scope,
      conversationId,
      ownerId,
      otherStaffId,
      'STAFF',
    );

    expect(result).toEqual({ ok: true });
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: conversationId },
      data: {
        assignedUserId: otherStaffId,
        aiPaused: true,
        handoffState: 'JOINED',
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'conversation.transfer',
        metadata: { fromUserId: ownerId, toUserId: otherStaffId },
      }),
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { conversationId },
      data: { assignedUserId: otherStaffId },
    });
  });

  it('allows a manager to reassign without being the current owner', async () => {
    await svc.transfer(
      scope,
      conversationId,
      managerId,
      otherStaffId,
      'MANAGER',
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('forbids a non-owner staff member from transferring', async () => {
    await expect(
      svc.transfer(scope, conversationId, otherStaffId, managerId, 'STAFF'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects transfer when the conversation is not taken over', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      locationId: 'loc-1',
      aiPaused: false,
      assignedUserId: null,
    });

    await expect(
      svc.transfer(scope, conversationId, ownerId, otherStaffId, 'STAFF'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects transfer to self', async () => {
    await expect(
      svc.transfer(scope, conversationId, ownerId, ownerId, 'STAFF'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OperationsService.recordReplyFeedback', () => {
  const scope = { tenantId: 'tenant-1', locationId: 'loc-1' };
  const userId = 'user-staff';

  const prisma = {
    conversation: { findFirst: jest.fn() },
    message: { findFirst: jest.fn() },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    analyticsEvent: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    conversationPlaybook: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  let svc: OperationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.auditLog.create.mockResolvedValue({});
    svc = makeOperationsService(prisma);
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      locationId: 'loc-1',
      externalKey: 'ext-key-1',
    });
    prisma.message.findFirst.mockResolvedValue({ id: 'asst-msg-1' });
    prisma.conversationPlaybook.findFirst.mockResolvedValue({ version: 2 });
    prisma.conversationPlaybook.create.mockResolvedValue({
      id: 'draft-pb-1',
      status: 'DRAFT',
    });
  });

  it('creates DRAFT coaching playbook for too_long and does not publish', async () => {
    const result = await svc.recordReplyFeedback(scope, userId, {
      conversationId: 'conv-1',
      messageId: 'asst-msg-1',
      label: 'too_long',
      note: 'Cut the intro fluff',
    });

    expect(result).toEqual({
      ok: true,
      label: 'too_long',
      draftPlaybookId: 'draft-pb-1',
    });
    expect(prisma.conversationPlaybook.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: scope.tenantId,
        locationId: 'loc-1',
        locationScope: 'loc-1',
        key: 'staff-feedback-coaching',
        title: 'Staff feedback: too_long',
        status: 'DRAFT',
        version: 3,
        tone: 'concise',
        brevity: 'short',
        oneQuestion: true,
        allowRapport: false,
        createdBy: userId,
        coachingNotes: expect.stringContaining('too long'),
      }),
    });
    expect(prisma.conversationPlaybook.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'ai.reply_feedback',
          metadata: expect.objectContaining({ label: 'too_long' }),
        }),
      }),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'playbook.publish' }),
      }),
    );
    expect(prisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'studio.feedback_draft_created',
          properties: expect.objectContaining({
            playbookId: 'draft-pb-1',
            label: 'too_long',
          }),
        }),
      }),
    );
  });

  it('skips draft playbook for good feedback labels', async () => {
    const result = await svc.recordReplyFeedback(scope, userId, {
      conversationId: 'conv-1',
      label: 'good',
    });

    expect(result).toEqual({
      ok: true,
      label: 'good',
      draftPlaybookId: null,
    });
    expect(prisma.conversationPlaybook.create).not.toHaveBeenCalled();
    expect(prisma.conversationPlaybook.update).not.toHaveBeenCalled();
  });
});

describe('OperationsService.appointmentOutcomes', () => {
  it('returns show rate from persisted completed and no-show counts', async () => {
    const prisma = {
      appointment: {
        count: jest
          .fn()
          .mockResolvedValueOnce(3)
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(5)
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(0),
      },
    };
    const svc = makeOperationsService(prisma);
    const r = await svc.appointmentOutcomes({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
    });
    expect(r.counts).toEqual({
      completed: 3,
      noShow: 1,
      confirmedOnBook: 5,
      awaitingConfirmation: 2,
      cancelled: 0,
    });
    expect(r.showRate).toBe(0.75);
    expect(r.window).toBe('7d');
    expect(prisma.appointment.count).toHaveBeenCalledTimes(5);
  });

  it('returns null show rate when no recorded outcomes', async () => {
    const prisma = {
      appointment: { count: jest.fn().mockResolvedValue(0) },
    };
    const svc = makeOperationsService(prisma);
    const r = await svc.appointmentOutcomes({
      tenantId: 'tenant-1',
      locationId: null,
    });
    expect(r.showRate).toBeNull();
  });
});

describe('OperationsService.missedOpportunities', () => {
  it('aggregates queue lengths and analytics miss counts without synthetic scores', async () => {
    const svc = makeOperationsService({});
    jest.spyOn(svc, 'overview').mockResolvedValue({
      window: '7d',
      since: '2026-10-01T00:00:00.000Z',
      aiQuality: { inventoryMisses: 2, knowledgeMisses: 1, replyFeedback: {} },
      attention: { partsOpen: 3, financeOpen: 2 },
    } as Awaited<ReturnType<OperationsService['overview']>>);
    jest.spyOn(svc, 'queues').mockResolvedValue({
      prioritized: {
        unansweredInbound: [{ id: 'c1' }],
        aiUncertain: [{ id: 'c2' }, { id: 'c3' }],
        overdueLeads: [],
        missedAppointments: [{ id: 'a1' }],
      },
    } as Awaited<ReturnType<OperationsService['queues']>>);

    const r = await svc.missedOpportunities({ tenantId: 'tenant-1', locationId: null });

    expect(r.prioritized).toEqual({
      unansweredInbound: 1,
      aiUncertainReplies: 2,
      overdueLeads: 0,
      missedAppointments: 1,
      partsOpen: 3,
      financeOpen: 2,
    });
    expect(r.aiMissSignals).toEqual({
      zeroInventoryResults: 2,
      knowledgeMiss: 1,
      unansweredInbound: 1,
    });
    expect(r.totals).toEqual({
      prioritizedQueueItems: 9,
      analyticsMissEvents: 3,
      combinedAttention: 12,
    });
    expect(r.note).toMatch(/persisted queues and analytics/);
  });
});

describe('OperationsService.executiveExplain', () => {
  it('answers lead questions from overview counts only', async () => {
    const svc = makeOperationsService({});
    jest.spyOn(svc, 'overview').mockResolvedValue({
      window: '7d',
      outcomes: { leadsCaptured: 12, creditLinksOffered: 0, creditLinksClicked: 0 },
      attention: { hotLeads: 3, partsOpen: 0, financeOpen: 0, tradesOpen: 0, openHandoffs: 0, appointmentsAwaitingConfirmation: 0 },
      aiQuality: {
        inventoryMisses: 0,
        knowledgeMisses: 0,
        replyFeedback: { total: 0, good: 0 },
      },
      technical: { inventory: { freshness: { FRESH: 10 } } },
    } as Awaited<ReturnType<OperationsService['overview']>>);
    jest.spyOn(svc, 'dailyBrief').mockResolvedValue({
      today: { appointmentsOnBook: 0 },
      priorities: [],
    } as Awaited<ReturnType<OperationsService['dailyBrief']>>);

    const r = await svc.executiveExplain(
      { tenantId: 'tenant-1', locationId: null },
      'How are leads?',
    );

    expect(r.source).toBe('platform_records');
    expect(r.metrics).toEqual({
      window: '7d',
      leadsCaptured7d: 12,
      hotLeads: 3,
    });
    expect(r.answer).toContain('12');
    expect(r.answer).toContain('3');
    expect(r.links).toContain('#/inbox');
  });

  it('answers knowledge questions from analytics miss counts', async () => {
    const svc = makeOperationsService({});
    jest.spyOn(svc, 'overview').mockResolvedValue({
      window: '7d',
      outcomes: { leadsCaptured: 0, creditLinksOffered: 0, creditLinksClicked: 0 },
      attention: { hotLeads: 0, partsOpen: 0, financeOpen: 0, tradesOpen: 0, openHandoffs: 0, appointmentsAwaitingConfirmation: 0 },
      aiQuality: {
        inventoryMisses: 0,
        knowledgeMisses: 5,
        replyFeedback: { total: 0, good: 0 },
      },
      technical: { inventory: { freshness: {} } },
    } as Awaited<ReturnType<OperationsService['overview']>>);
    jest.spyOn(svc, 'dailyBrief').mockResolvedValue({
      today: { appointmentsOnBook: 0 },
      priorities: [],
    } as Awaited<ReturnType<OperationsService['dailyBrief']>>);

    const r = await svc.executiveExplain(
      { tenantId: 'tenant-1', locationId: 'loc-1' },
      'knowledge gaps',
    );

    expect(r.metrics.knowledgeMisses7d).toBe(5);
    expect(r.answer).toContain('5');
    expect(r.links).toEqual(['#/knowledge']);
  });
});

describe('OperationsService.dailyBrief', () => {
  it('surfaces AI miss analytics as brief priorities with deep links', async () => {
    const prisma = {
      appointment: { count: jest.fn().mockResolvedValue(0) },
    };
    const svc = makeOperationsService(prisma);
    jest.spyOn(svc, 'overview').mockResolvedValue({
      window: '7d',
      outcomes: { leadsCaptured: 0, confirmedAppointments: 0 },
      attention: {
        openHandoffs: 0,
        appointmentsAwaitingConfirmation: 0,
        partsOpen: 0,
        financeOpen: 0,
      },
      aiQuality: {
        inventoryMisses: 4,
        knowledgeMisses: 2,
        replyFeedback: { total: 0 },
      },
    } as Awaited<ReturnType<OperationsService['overview']>>);
    jest.spyOn(svc, 'queues').mockResolvedValue({
      prioritized: {
        unansweredInbound: [],
        aiUncertain: [],
        overdueLeads: [],
        missedAppointments: [],
      },
    } as Awaited<ReturnType<OperationsService['queues']>>);
    jest.spyOn(svc as never, 'surveyProviderConnected').mockReturnValue(false);

    const r = await svc.dailyBrief({ tenantId: 'tenant-1', locationId: null });

    expect(r.priorities).toEqual(
      expect.arrayContaining([
        { key: 'knowledge_misses', count: 2, href: '#/knowledge' },
        { key: 'inventory_misses', count: 4, href: '#/inventory' },
      ]),
    );
  });
});

describe('OperationsService.recentKnowledgeMisses', () => {
  it('returns persisted knowledge_miss rows without conversation identifiers', async () => {
    const occurredAt = new Date('2026-10-10T12:00:00.000Z');
    const prisma = {
      analyticsEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ev-1',
            occurredAt,
            locationId: 'loc-1',
            properties: { count: 0 },
          },
        ]),
      },
    };
    const svc = makeOperationsService(prisma);
    const r = await svc.recentKnowledgeMisses({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
    });
    expect(r.window).toBe('7d');
    expect(r.total).toBe(1);
    expect(r.events).toEqual([
      {
        id: 'ev-1',
        occurredAt,
        locationId: 'loc-1',
        kbHits: 0,
      },
    ]);
    expect(prisma.analyticsEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          locationId: 'loc-1',
          eventType: 'knowledge_miss',
        }),
        select: expect.not.objectContaining({
          conversationExternalKey: expect.anything(),
        }),
      }),
    );
  });

  it('returns empty for scoped tenant when rows exist only under another tenant', async () => {
    const otherTenantRow = {
      id: 'ev-other-tenant',
      occurredAt: new Date('2026-10-10T12:00:00.000Z'),
      locationId: 'loc-other',
      properties: { count: 3 },
    };
    const prisma = {
      analyticsEvent: {
        findMany: jest.fn().mockImplementation(({ where }: { where: { tenantId: string } }) =>
          where.tenantId === 'tenant-a'
            ? Promise.resolve([otherTenantRow])
            : Promise.resolve([]),
        ),
      },
    };
    const svc = makeOperationsService(prisma);
    const r = await svc.recentKnowledgeMisses({
      tenantId: 'tenant-b',
      locationId: null,
    });
    expect(r.total).toBe(0);
    expect(r.events).toEqual([]);
    expect(prisma.analyticsEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-b' }),
      }),
    );
  });
});

describe('OperationsService.listInventory', () => {
  it('delegates GET /ops/inventory to browseForStaff with scope and filters', async () => {
    const browseForStaff = jest.fn().mockResolvedValue([]);
    const svc = makeOperationsService({}, { inventory: { browseForStaff } });
    await svc.listInventory(
      { tenantId: 'tenant-1', locationId: 'loc-1' },
      { vin: '1C4', stock: 'STK', make: 'Jeep', model: 'Wrangler', q: 'rubicon' },
    );
    expect(browseForStaff).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      vin: '1C4',
      stock: 'STK',
      make: 'Jeep',
      model: 'Wrangler',
      q: 'rubicon',
    });
  });
});

describe('OperationsService inbox appointment priority wording', () => {
  const priority = (
    svc: OperationsService,
    handoff: string,
    stage: string | null,
    appointmentStatus: string | null,
  ) =>
    (
      svc as unknown as {
        priority: (
          h: string,
          s: string | null,
          a: string | null,
        ) => { rank: number; reason: string };
      }
    ).priority(handoff, stage, appointmentStatus);

  it('does not label confirmed appointments as awaiting confirmation', () => {
    const svc = makeOperationsService({});
    expect(priority(svc, 'NONE', null, 'REQUESTED').reason).toBe(
      'Appointment request awaiting confirmation',
    );
    expect(priority(svc, 'NONE', null, 'PENDING_CONFIRMATION').reason).toBe(
      'Appointment request awaiting confirmation',
    );
    expect(priority(svc, 'NONE', null, 'CONFIRMED')).toEqual({
      rank: 6,
      reason: 'Confirmed appointment on file',
    });
  });
});
