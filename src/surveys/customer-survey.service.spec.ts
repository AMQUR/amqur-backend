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
    auditLog: { create: jest.fn().mockResolvedValue({}) },
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
    });
    const row = await svc.createDraft({
      tenantId: 't1',
      channel: 'LINK',
      createdByUserId: 'u1',
    });
    expect(row.status).toBe('DRAFT');
    expect(prisma.customerSurvey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'DRAFT',
        channel: 'LINK',
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
    });
    prisma.customerSurvey.update.mockResolvedValue({
      id: 's1',
      status: 'RESPONDED',
      score: 9,
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
      }),
    });
  });
});
