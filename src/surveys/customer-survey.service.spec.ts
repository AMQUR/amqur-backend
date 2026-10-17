import { BadRequestException } from '@nestjs/common';
import { CustomerSurveyService } from './customer-survey.service';

describe('CustomerSurveyService', () => {
  const prisma = {
    lead: { findFirst: jest.fn() },
    customerSurvey: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    customerSurveyTemplate: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    analyticsEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const svc = new CustomerSurveyService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('createDraft never marks status SENT', async () => {
    prisma.customerSurvey.create.mockResolvedValue({
      id: 's1',
      status: 'DRAFT',
      channel: 'LINK',
      kind: 'SALES',
    });
    const row = await svc.createDraft({
      tenantId: 't1',
      channel: 'LINK',
      kind: 'SALES',
      createdByUserId: 'u1',
    });
    expect(row.status).toBe('DRAFT');
    expect(prisma.customerSurvey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'DRAFT',
        channel: 'LINK',
        kind: 'SALES',
        tenantId: 't1',
      }),
    });
  });

  it('recordResponse rejects out-of-range scores', async () => {
    await expect(
      svc.recordResponse({ tenantId: 't1', surveyId: 's1', score: 11 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.customerSurvey.update).not.toHaveBeenCalled();
  });

  it('recordResponse stores score on RESPONDED', async () => {
    prisma.customerSurvey.findFirst.mockResolvedValue({
      id: 's1',
      status: 'DRAFT',
      kind: 'SALES',
    });
    prisma.customerSurvey.update.mockResolvedValue({
      id: 's1',
      status: 'RESPONDED',
      score: 9,
      kind: 'SALES',
      followUpRequired: false,
    });
    const row = await svc.recordResponse({
      tenantId: 't1',
      surveyId: 's1',
      score: 9,
      actorUserId: 'u1',
    });
    expect(row.score).toBe(9);
    expect(prisma.customerSurvey.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: expect.objectContaining({
        status: 'RESPONDED',
        score: 9,
        followUpRequired: false,
        followUpStatus: 'NONE',
      }),
    });
  });

  it('recordResponse queues manager follow-up for low scores', async () => {
    prisma.customerSurvey.findFirst.mockResolvedValue({
      id: 's1',
      status: 'DRAFT',
      kind: 'SERVICE',
      locationId: 'loc-1',
    });
    prisma.customerSurvey.update.mockResolvedValue({
      id: 's1',
      status: 'RESPONDED',
      score: 4,
      kind: 'SERVICE',
      locationId: 'loc-1',
      followUpRequired: true,
      followUpStatus: 'PENDING',
    });
    await svc.recordResponse({
      tenantId: 't1',
      surveyId: 's1',
      score: 4,
      comment: 'Service was terrible',
      actorUserId: 'u1',
    });
    expect(prisma.customerSurvey.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: expect.objectContaining({
        followUpRequired: true,
        followUpStatus: 'PENDING',
      }),
    });
    expect(prisma.analyticsEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'csi.follow_up_queued',
      }),
    });
  });

  it('acknowledgeFollowUp claims PENDING survey', async () => {
    prisma.customerSurvey.findFirst.mockResolvedValue({
      id: 's1',
      followUpStatus: 'PENDING',
    });
    prisma.customerSurvey.update.mockResolvedValue({
      id: 's1',
      followUpStatus: 'ACKNOWLEDGED',
      assignedManagerUserId: 'mgr-1',
    });
    const row = await svc.acknowledgeFollowUp({
      tenantId: 't1',
      surveyId: 's1',
      actorUserId: 'mgr-1',
    });
    expect(row.followUpStatus).toBe('ACKNOWLEDGED');
  });
});
