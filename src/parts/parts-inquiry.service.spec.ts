import { PartsInquiryStatus } from '@prisma/client';
import { PartsInquiryService } from './parts-inquiry.service';

const VALID_VIN = '1HGCM82633A004352';

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
    jest.resetAllMocks();
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
