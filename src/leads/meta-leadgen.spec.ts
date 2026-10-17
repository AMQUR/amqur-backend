import { LeadStage, LeadStatus } from '@prisma/client';
import { LeadsService, resolveLeadStatus } from './leads.service';

describe('LeadsService.upsertFromMetaLeadgen', () => {
  const prisma = {
    lead: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  };
  const flags = {
    resolve: jest.fn().mockResolvedValue({ roundRobinAssign: false }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns existing lead without creating a duplicate', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-existing' });
    const svc = new LeadsService(prisma as never, flags as never);

    const res = await svc.upsertFromMetaLeadgen({
      tenantId: 't1',
      leadgenId: 'lg-99',
      webhookInboxId: 'inbox-9',
      needsStaffReview: true,
    });

    expect(res).toEqual({ lead: { id: 'lead-existing' }, created: false });
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('creates meta_leadgen source with scoreReasons and no fabricated contact', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    prisma.lead.create.mockResolvedValue({ id: 'lead-new' });
    const svc = new LeadsService(prisma as never, flags as never);

    await svc.upsertFromMetaLeadgen({
      tenantId: 't1',
      leadgenId: 'lg-99',
      webhookInboxId: 'inbox-9',
      needsStaffReview: true,
      metaContext: { adId: 'ad-1' },
    });

    expect(prisma.lead.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 't1',
        source: 'meta_leadgen',
        firstName: undefined,
        email: undefined,
        phone: undefined,
        score: 0,
        stage: LeadStage.COLD,
        status: LeadStatus.OPEN,
        scoreReasons: {
          metaLeadgenId: 'lg-99',
          webhookInboxId: 'inbox-9',
          needsStaffReview: true,
          metaContext: { adId: 'ad-1' },
        },
        notes: expect.stringContaining('staff review'),
      }),
    });
    expect(resolveLeadStatus({ score: 0, stage: 'cold' })).toBe(
      LeadStatus.OPEN,
    );
  });
});
