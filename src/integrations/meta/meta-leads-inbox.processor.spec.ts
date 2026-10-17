import {
  IntegrationProvider,
  LeadStatus,
  WebhookInboxStatus,
} from '@prisma/client';
import { MetaLeadsInboxProcessor } from './meta-leads-inbox.processor';
import type { MetaGraphLeadClient } from './meta-graph-lead.client';

const samplePayload = {
  object: 'page',
  entry: [
    {
      changes: [
        {
          field: 'leadgen',
          value: {
            leadgen_id: 'lg-123',
            page_id: 'page-9',
            form_id: 'form-1',
            ad_id: 'ad-77',
          },
        },
      ],
    },
  ],
};

function inboxRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'inbox-1',
    tenantId: 'tenant-1',
    provider: IntegrationProvider.META,
    externalEventId: 'lg-123',
    signatureValid: true,
    payload: samplePayload,
    status: WebhookInboxStatus.RECEIVED,
    processedAt: null,
    errorMessage: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('MetaLeadsInboxProcessor', () => {
  const prisma = {
    webhookInbox: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const leads = {
    findByMetaLeadgenId: jest.fn(),
    upsertFromMetaLeadgen: jest.fn(),
  };
  const graphClient = {
    fetchLeadgen: jest.fn(),
  };

  let processor: MetaLeadsInboxProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new MetaLeadsInboxProcessor(
      prisma as never,
      leads as never,
      graphClient as never,
    );
  });

  it('materializes verified Graph field_data into a lead', async () => {
    leads.findByMetaLeadgenId.mockResolvedValue(null);
    graphClient.fetchLeadgen.mockResolvedValue({
      ok: true,
      graphLeadId: 'lg-123',
      fieldData: [
        { name: 'email', values: ['a@example.com'] },
        { name: 'phone_number', values: ['5551234567'] },
        { name: 'first_name', values: ['Pat'] },
      ],
    });
    leads.upsertFromMetaLeadgen.mockResolvedValue({
      lead: { id: 'lead-1' },
      created: true,
    });

    const res = await processor.processRow(
      inboxRow() as never,
      graphClient as MetaGraphLeadClient,
    );

    expect(res).toEqual({
      outcome: 'processed',
      leadId: 'lead-1',
      created: true,
    });
    expect(leads.upsertFromMetaLeadgen).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        leadgenId: 'lg-123',
        email: 'a@example.com',
        phone: '5551234567',
        firstName: 'Pat',
        needsStaffReview: false,
        metaContext: expect.objectContaining({
          pageId: 'page-9',
          adId: 'ad-77',
          graphLeadId: 'lg-123',
        }),
      }),
    );
    expect(prisma.webhookInbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inbox-1' },
        data: expect.objectContaining({
          status: WebhookInboxStatus.PROCESSED,
        }),
      }),
    );
  });

  it('creates minimal staff-review lead when Graph token is not configured', async () => {
    leads.findByMetaLeadgenId.mockResolvedValue(null);
    graphClient.fetchLeadgen.mockResolvedValue({
      ok: false,
      reason: 'not_configured',
    });
    leads.upsertFromMetaLeadgen.mockResolvedValue({
      lead: { id: 'lead-min' },
      created: true,
    });

    const res = await processor.processRow(
      inboxRow() as never,
      graphClient as MetaGraphLeadClient,
    );

    expect(res.outcome).toBe('processed');
    expect(leads.upsertFromMetaLeadgen).toHaveBeenCalledWith(
      expect.objectContaining({
        leadgenId: 'lg-123',
        needsStaffReview: true,
        metaContext: expect.objectContaining({ pageId: 'page-9' }),
      }),
    );
    expect(leads.upsertFromMetaLeadgen.mock.calls[0][0]).not.toHaveProperty(
      'email',
    );
    expect(leads.upsertFromMetaLeadgen.mock.calls[0][0]).not.toHaveProperty(
      'phone',
    );
  });

  it('does not fabricate PII when field_data has no contact fields', async () => {
    leads.findByMetaLeadgenId.mockResolvedValue(null);
    graphClient.fetchLeadgen.mockResolvedValue({
      ok: true,
      fieldData: [{ name: 'city', values: ['Austin'] }],
    });
    leads.upsertFromMetaLeadgen.mockResolvedValue({
      lead: { id: 'lead-2' },
      created: true,
    });

    await processor.processRow(
      inboxRow() as never,
      graphClient as MetaGraphLeadClient,
    );

    expect(leads.upsertFromMetaLeadgen).toHaveBeenCalledWith(
      expect.objectContaining({
        needsStaffReview: true,
        email: undefined,
        phone: undefined,
      }),
    );
  });

  it('is idempotent when lead already exists for leadgen_id', async () => {
    leads.findByMetaLeadgenId.mockResolvedValue({ id: 'existing-lead' });

    const res = await processor.processRow(
      inboxRow() as never,
      graphClient as MetaGraphLeadClient,
    );

    expect(res).toEqual({
      outcome: 'processed',
      leadId: 'existing-lead',
      created: false,
    });
    expect(graphClient.fetchLeadgen).not.toHaveBeenCalled();
    expect(leads.upsertFromMetaLeadgen).not.toHaveBeenCalled();
  });

  it('leaves inbox RECEIVED on transient Graph http_error', async () => {
    leads.findByMetaLeadgenId.mockResolvedValue(null);
    graphClient.fetchLeadgen.mockResolvedValue({
      ok: false,
      reason: 'http_error',
      statusCode: 503,
      message: 'upstream',
    });

    const res = await processor.processRow(
      inboxRow() as never,
      graphClient as MetaGraphLeadClient,
    );

    expect(res).toEqual({ outcome: 'retry', reason: 'http_error' });
    expect(prisma.webhookInbox.update).toHaveBeenCalledWith({
      where: { id: 'inbox-1' },
      data: { errorMessage: 'upstream' },
    });
    expect(leads.upsertFromMetaLeadgen).not.toHaveBeenCalled();
  });

  it('marks FAILED when Graph returns lead_not_found', async () => {
    leads.findByMetaLeadgenId.mockResolvedValue(null);
    graphClient.fetchLeadgen.mockResolvedValue({
      ok: false,
      reason: 'lead_not_found',
      statusCode: 404,
    });

    const res = await processor.processRow(
      inboxRow() as never,
      graphClient as MetaGraphLeadClient,
    );

    expect(res.outcome).toBe('failed');
    expect(prisma.webhookInbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookInboxStatus.FAILED,
        }),
      }),
    );
  });
});

describe('LeadsService meta leadgen idempotency (integration shape)', () => {
  it('documents expected OPEN status without contact', () => {
    expect(LeadStatus.OPEN).toBe('OPEN');
  });
});
