import { NotFoundException } from '@nestjs/common';
import { PartsInquiryStatus } from '@prisma/client';
import { PartsInquiryService } from './parts-inquiry.service';

const VALID_VIN = '1HGCM82633A004352';

describe('PartsInquiryService.upsertFromActionPage', () => {
  const prisma = {
    partsInquiry: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    escalation: {
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'esc-ap' }),
    },
    analyticsEvent: {
      create: jest.fn().mockResolvedValue({}),
    },
  };

  const svc = new PartsInquiryService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.escalation.findFirst.mockResolvedValue(null);
  });

  it('creates PENDING_STAFF inquiry and queues PARTS_ADVISOR when conversation linked', async () => {
    prisma.partsInquiry.findUnique.mockResolvedValue(null);
    prisma.partsInquiry.create.mockResolvedValue({
      id: 'pi-ap',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      status: PartsInquiryStatus.PENDING_STAFF,
      suspectedPart: null,
      partNumber: 'ABC123',
      partDescription: 'Oil filter',
      vin: VALID_VIN,
    });

    await svc.upsertFromActionPage({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      actionPageId: 'page-1',
      description: 'Oil filter',
      partNumber: 'ABC123',
      vin: VALID_VIN,
    });

    expect(prisma.partsInquiry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey: 'action_page:page-1',
          status: PartsInquiryStatus.PENDING_STAFF,
          fitmentVerified: false,
          priceVerified: false,
          provenance: expect.objectContaining({ source: 'action_page' }),
        }),
      }),
    );
    expect(prisma.escalation.create).toHaveBeenCalledTimes(1);
  });

  it('returns existing row for the same action page idempotency key', async () => {
    prisma.partsInquiry.findUnique.mockResolvedValue({
      id: 'pi-existing',
      status: PartsInquiryStatus.FITMENT_PENDING,
    });

    const row = await svc.upsertFromActionPage({
      tenantId: 'tenant-1',
      actionPageId: 'page-1',
      description: 'Bulb',
    });

    expect(row.id).toBe('pi-existing');
    expect(prisma.partsInquiry.create).not.toHaveBeenCalled();
  });
});

describe('PartsInquiryService.notifyPartsAdvisor (via upsertForConversation)', () => {
  const prisma = {
    partsInquiry: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    escalation: {
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'esc-1' }),
    },
    analyticsEvent: {
      create: jest.fn().mockResolvedValue({}),
    },
  };

  const svc = new PartsInquiryService(prisma as never);

  const upsertInput = {
    tenantId: 'tenant-1',
    locationId: 'loc-1',
    conversationId: 'conv-1',
    description: 'Front brake pads',
    suspectedPart: 'brake pads',
    vin: VALID_VIN,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.escalation.findFirst.mockResolvedValue(null);
    prisma.escalation.create.mockResolvedValue({ id: 'esc-1' });
    prisma.analyticsEvent.create.mockResolvedValue({});
  });

  it('queues PARTS_ADVISOR escalation when a new inquiry is PENDING_STAFF', async () => {
    prisma.partsInquiry.findUnique.mockResolvedValue(null);
    prisma.partsInquiry.create.mockResolvedValue({
      id: 'pi-new',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      status: PartsInquiryStatus.PENDING_STAFF,
      suspectedPart: 'brake pads',
      partNumber: null,
      partDescription: 'Front brake pads',
      vin: VALID_VIN,
    });

    await svc.upsertForConversation(upsertInput);

    expect(prisma.escalation.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
        reason: 'PARTS_ADVISOR',
      },
    });
    expect(prisma.escalation.create).toHaveBeenCalledTimes(1);
    expect(prisma.escalation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        locationId: 'loc-1',
        conversationId: 'conv-1',
        reason: 'PARTS_ADVISOR',
        urgency: 'NORMAL',
        metadata: expect.objectContaining({
          partsInquiryId: 'pi-new',
          fitmentVerified: false,
        }),
      }),
    });
    expect(prisma.analyticsEvent.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        locationId: 'loc-1',
        eventType: 'parts.advisor_queued',
        properties: { partsInquiryId: 'pi-new' },
      },
    });
  });

  it('does not create a second escalation when an open PARTS_ADVISOR already exists', async () => {
    prisma.partsInquiry.findUnique.mockResolvedValue(null);
    prisma.escalation.findFirst.mockResolvedValue({
      id: 'esc-open',
      reason: 'PARTS_ADVISOR',
    });
    prisma.partsInquiry.create.mockResolvedValue({
      id: 'pi-new',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      status: PartsInquiryStatus.PENDING_STAFF,
      suspectedPart: 'brake pads',
      partNumber: null,
      partDescription: 'Front brake pads',
      vin: VALID_VIN,
    });

    await svc.upsertForConversation(upsertInput);

    expect(prisma.escalation.create).not.toHaveBeenCalled();
    expect(prisma.analyticsEvent.create).not.toHaveBeenCalled();
  });

  it('escalates once when FITMENT_PENDING becomes PENDING_STAFF on update', async () => {
    prisma.partsInquiry.findUnique.mockResolvedValue({
      id: 'pi-existing',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      status: PartsInquiryStatus.FITMENT_PENDING,
    });
    prisma.partsInquiry.update.mockResolvedValue({
      id: 'pi-existing',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      status: PartsInquiryStatus.PENDING_STAFF,
      suspectedPart: 'brake pads',
      partNumber: null,
      partDescription: 'Front brake pads',
      vin: VALID_VIN,
    });

    await svc.upsertForConversation(upsertInput);

    expect(prisma.escalation.create).toHaveBeenCalledTimes(1);
  });
});

describe('PartsInquiryService.updateStaff', () => {
  const prisma = {
    partsInquiry: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    escalation: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  let svc: PartsInquiryService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new PartsInquiryService(prisma as never);
    prisma.partsInquiry.findFirst.mockResolvedValue({
      id: 'pi-1',
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      status: PartsInquiryStatus.PENDING_STAFF,
      fitmentVerified: false,
      priceVerified: false,
    });
    prisma.partsInquiry.update.mockResolvedValue({
      id: 'pi-1',
      status: PartsInquiryStatus.QUOTED,
      notes: 'Checked DMS',
    });
    prisma.escalation.findMany.mockResolvedValue([]);
  });

  it('updates status without touching verification flags', async () => {
    const row = await svc.updateStaff('tenant-1', 'loc-1', 'pi-1', 'user-1', {
      status: PartsInquiryStatus.QUOTED,
    });
    expect(row.status).toBe('QUOTED');
    expect(prisma.partsInquiry.update).toHaveBeenCalledWith({
      where: { id: 'pi-1' },
      data: { status: 'QUOTED' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'parts_inquiry.update',
          resourceId: 'pi-1',
        }),
      }),
    );
  });

  it('acknowledges matching PARTS_ADVISOR escalation', async () => {
    prisma.escalation.findMany.mockResolvedValue([
      {
        id: 'esc-1',
        metadata: { partsInquiryId: 'pi-1' },
      },
    ]);

    await svc.updateStaff('tenant-1', 'loc-1', 'pi-1', 'user-1', {
      acknowledgeEscalation: true,
    });

    expect(prisma.escalation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['esc-1'] } },
      data: { status: 'ACKNOWLEDGED' },
    });
    expect(prisma.partsInquiry.update).not.toHaveBeenCalled();
  });

  it('throws when inquiry is out of scope', async () => {
    prisma.partsInquiry.findFirst.mockResolvedValue(null);
    await expect(
      svc.updateStaff('tenant-1', 'loc-1', 'pi-missing', 'user-1', {
        notes: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
