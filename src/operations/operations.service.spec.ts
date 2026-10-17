import { ConflictException, NotFoundException } from '@nestjs/common';
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
    const r = await svc.satisfaction({ tenantId: 'tenant-1', locationId: null });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('survey_provider_not_connected');
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
