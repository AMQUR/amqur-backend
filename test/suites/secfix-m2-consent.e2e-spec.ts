import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { DemoDealer, seedDemoDealer, SIM_ORIGIN } from '../helpers/demo-dealer';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import { LeadDeliveryService } from '../../src/integrations/adf/lead-delivery.service';
import { LeadDeliveryRouteService } from '../../src/integrations/adf/lead-delivery-route.service';
import { SandboxSinkTransport } from '../../src/integrations/adf/transports/sandbox-sink.transport';
import { seedSandboxRoutes } from '../../src/integrations/adf/sandbox-routes.seed';
import { ConsentService } from '../../src/messaging/consent.service';
import {
  GRANT_NOT_EFFECTIVE_HANDSET_OPT_OUT,
  textStaysOffText,
} from '../../src/messaging/handset-opt-out';
import { LEAD_FORM_CONSENT_VERSION } from '../../src/chat/sales-desk/consent-wording';

/**
 * Security review M2 — the web lead form does not verify phone ownership, so ticking "text OK"
 * for a number that texted STOP must not re-open SMS consent or tell the CRM `text=yes`.
 * Full path: widget lead form → consent ledger → lead → ADF document (sandbox sink).
 * Synthetic data only (example.invalid, 555-01xx).
 */
type Card = Record<string, unknown> & { kind: string };
type Chat = { reply: string; cards: Card[]; conversationId: string };
const ENV_KEYS = [
  'OUTBOX_PROCESSOR_ENABLED',
  'ADF_SEND_ENABLED',
  'LEAD_DELIVERY_MODE',
  'ADF_SANDBOX_TRANSPORT',
] as const;
const VICTIM = '(312) 555-0177';
const VICTIM_E164 = '+13125550177';
const OWNER = '(312) 555-0178';
const OWNER_E164 = '+13125550178';

describe('M2 a form "text OK" cannot undo a handset STOP', () => {
  let ctx: E2eCtx;
  let dealer: DemoDealer;
  let consent: ConsentService;
  let deliveries: LeadDeliveryService;
  let processor: OutboxProcessorService;
  let sink: SandboxSinkTransport;
  let token = '';
  const prev: Record<string, string | undefined> = {};
  const srv = () => request(ctx.app.getHttpServer());
  const chat = async (body: object): Promise<Chat> => {
    const r = await srv()
      .post('/api/chat')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', SIM_ORIGIN)
      .send(body);
    if (r.status >= 300) throw new Error(`chat ${r.status}: ${r.text}`);
    return unwrap<Chat>(r.body);
  };
  const card = <T>(c: Chat, kind: string) =>
    c.cards.find((x) => x.kind === kind) as T | undefined;
  const handset = async (endpoint: string, granted: boolean) => {
    // Exactly what the inbound-SMS webhook records for STOP / START.
    for (const purpose of granted
      ? (['CONVERSATIONAL'] as const)
      : (['CONVERSATIONAL', 'MARKETING'] as const))
      await consent.record({
        tenantId: dealer.tenantId,
        channel: 'SMS',
        endpoint,
        purpose,
        granted,
        source: 'SMS_KEYWORD',
        evidence: { keyword: granted ? 'START' : 'STOP' },
      });
  };
  /** A visitor submits the lead form with "text OK" ticked for `phone`. */
  const submitTextOk = async (phone: string, email: string) => {
    const a = await chat({ action: 'test_drive', vin: dealer.vehicles[0].vin });
    const p = card<{ id: string; days: string[] }>(a, 'appointment_picker')!;
    const b = await chat({
      action: 'appointment_select',
      conversationId: a.conversationId,
      appointment: {
        pickerId: p.id,
        requestedDate: p.days[0],
        requestedWindow: 'morning',
      },
    });
    const f = card<{ id: string; channels: string[] }>(b, 'lead_form')!;
    expect(f.channels).toContain('TEXT');
    const c = await chat({
      action: 'lead_capture',
      conversationId: a.conversationId,
      lead: {
        formId: f.id,
        firstName: 'Pat',
        lastName: 'Rivera',
        email,
        phone,
        preferredChannel: 'TEXT',
        consents: [
          {
            channel: 'TEXT',
            granted: true,
            version: LEAD_FORM_CONSENT_VERSION,
          },
          {
            channel: 'EMAIL',
            granted: true,
            version: LEAD_FORM_CONSENT_VERSION,
          },
        ],
      },
    });
    const conv = await ctx.prisma.conversation.findUniqueOrThrow({
      where: {
        tenantId_externalKey: {
          tenantId: dealer.tenantId,
          externalKey: a.conversationId,
        },
      },
    });
    const lead = await ctx.prisma.lead.findFirstOrThrow({
      where: { tenantId: dealer.tenantId, email },
      orderBy: { createdAt: 'desc' },
    });
    return { reply: c, conversationId: a.conversationId, conv, lead };
  };
  /** Deliver the lead's ADF document to the sandbox sink and return the XML. */
  const adfFor = async (leadId: string) => {
    await deliveries.enqueueForLead(dealer.tenantId, leadId);
    const d = await ctx.prisma.leadDelivery.findFirstOrThrow({
      where: { leadId },
    });
    await ctx.prisma.outboxEvent.update({
      where: { id: d.outboxEventId as string },
      data: { nextAttemptAt: new Date(0) },
    });
    await processor.processBatch(500, 'sfm2-e2e');
    const after = await ctx.prisma.leadDelivery.findUniqueOrThrow({
      where: { id: d.id },
    });
    expect(after.status).toBe('ACCEPTED');
    const msg = sink.messages().find((m) => m.deliveryId === d.id)!;
    return msg.xml;
  };
  const smsRows = (conversationId: string) =>
    ctx.prisma.consentRecord.findMany({
      where: {
        tenantId: dealer.tenantId,
        conversationExternalKey: conversationId,
        channel: 'SMS',
      },
    });

  beforeAll(async () => {
    for (const k of ENV_KEYS) prev[k] = process.env[k];
    process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
    process.env.ADF_SEND_ENABLED = 'true';
    process.env.LEAD_DELIVERY_MODE = 'sandbox';
    process.env.ADF_SANDBOX_TRANSPORT = 'sink';
    ctx = await createE2eApp();
    consent = ctx.app.get(ConsentService);
    deliveries = ctx.app.get(LeadDeliveryService);
    processor = ctx.app.get(OutboxProcessorService);
    sink = ctx.app.get(SandboxSinkTransport);
    dealer = await seedDemoDealer(ctx.app, ctx.prisma, 'sfm2-consent', {
      creditPreview: false,
      flags: { salesDeskCards: true, sms: true, adfLeadDelivery: true },
    });
    await seedSandboxRoutes(
      ctx.app.get(LeadDeliveryRouteService),
      [
        {
          tenantId: dealer.tenantId,
          locationId: dealer.locationId,
          slug: dealer.slug,
        },
      ],
      'cli:sfm2-e2e',
    );
    // Synthetic numbers repeat between runs: start from an empty ledger and no old leads.
    await ctx.prisma.consentRecord.deleteMany({
      where: { tenantId: dealer.tenantId },
    });
    await ctx.prisma.leadDelivery.deleteMany({
      where: { tenantId: dealer.tenantId },
    });
    await ctx.prisma.lead.deleteMany({ where: { tenantId: dealer.tenantId } });
    const r = await srv()
      .post('/api/public/widget-token')
      .set('Origin', SIM_ORIGIN)
      .send({ tenantSlug: dealer.slug, locationSlug: 'main' });
    token = unwrap<{ token: string }>(r.body).token;
  }, 120_000);
  afterAll(async () => {
    await ctx.prisma.outboxEvent.updateMany({
      where: {
        tenantId: dealer.tenantId,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      data: { status: 'DEAD', lastError: 'test_suite_cleanup' },
    });
    await deliveries.sweepBehindDeadOutbox({ tenantId: dealer.tenantId });
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await ctx.app.close();
  });

  it('control: with no handset opt-out the form grant works exactly as before (text=yes, cellphone)', async () => {
    const { reply, conversationId, conv, lead } = await submitTextOk(
      OWNER,
      'sfm2-owner@example.invalid',
    );
    expect(reply.reply).not.toContain(textStaysOffText('en'));
    const rows = await smsRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint: OWNER_E164, granted: true });
    expect(rows[0].evidence).not.toHaveProperty('notEffective');
    expect(
      (conv.state as { contact: Record<string, unknown> }).contact,
    ).toMatchObject({ consentToText: true });
    expect(lead.consentToText).toBe(true);
    await expect(
      consent.status(dealer.tenantId, 'SMS', OWNER, 'CONVERSATIONAL'),
    ).resolves.toMatchObject({ allowed: true });
    const xml = await adfFor(lead.id);
    expect(xml).toMatch(/Consent: text=yes/);
    expect(xml).toContain('type="cellphone"');
  });

  it('exploit: victim texted STOP; a visitor submits the victim’s number with "text OK" ⇒ texting stays off everywhere', async () => {
    await handset(VICTIM_E164, false);
    const { reply, conversationId, conv, lead } = await submitTextOk(
      VICTIM,
      'sfm2-visitor@example.invalid',
    );

    // the customer is told truthfully, in neutral words (nothing about the number's history)
    expect(reply.reply).toContain(textStaysOffText('en'));
    expect(reply.reply).not.toMatch(/opted out|opt-out|unsubscrib|\bSTOP\b/i);

    // the tick is on the ledger as evidence, marked not effective
    const rows = await smsRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpoint: VICTIM_E164,
      granted: true,
      source: 'WIDGET',
    });
    expect(rows[0].evidence).toMatchObject({
      notEffective: GRANT_NOT_EFFECTIVE_HANDSET_OPT_OUT,
    });

    // neither the journey nor the lead is flagged textable
    expect(
      (conv.state as { contact: Record<string, unknown> }).contact
        .consentToText,
    ).not.toBe(true);
    expect(lead.consentToText).toBe(false);

    // resolver 1: ConsentService.status (what every SMS send checks)
    for (const purpose of ['CONVERSATIONAL', 'MARKETING'] as const)
      await expect(
        consent.status(dealer.tenantId, 'SMS', VICTIM, purpose),
      ).resolves.toEqual({ allowed: false, reason: 'opted_out' });

    // resolver 2 + the ADF summary the CRM receives
    const xml = await adfFor(lead.id);
    expect(xml).toMatch(/Consent: text=no, email=yes/);
    expect(xml).not.toContain('type="cellphone"');
    expect(xml).not.toMatch(/text=yes/);
  });

  it('repeating the form many times never pushes the STOP out of reach', async () => {
    for (let i = 0; i < 25; i += 1)
      await consent.record({
        tenantId: dealer.tenantId,
        channel: 'SMS',
        endpoint: VICTIM_E164,
        purpose: 'CONVERSATIONAL',
        granted: true,
        source: 'WIDGET',
        evidence: { capturedVia: 'lead_form' },
      });
    await expect(
      consent.status(dealer.tenantId, 'SMS', VICTIM, 'CONVERSATIONAL'),
    ).resolves.toEqual({ allowed: false, reason: 'opted_out' });
    const lead = await ctx.prisma.lead.create({
      data: {
        tenantId: dealer.tenantId,
        locationId: dealer.locationId,
        firstName: 'Synthetic',
        lastName: 'Repeat',
        email: 'sfm2-repeat@example.invalid',
        phone: VICTIM_E164,
        consentToText: true,
        consentToEmail: true,
        source: 'widget',
      },
    });
    const xml = await adfFor(lead.id);
    expect(xml).toMatch(/Consent: text=no/);
    expect(xml).not.toContain('type="cellphone"');
  });

  it('only a handset START re-opens texting', async () => {
    await handset(VICTIM_E164, true);
    await expect(
      consent.status(dealer.tenantId, 'SMS', VICTIM, 'CONVERSATIONAL'),
    ).resolves.toMatchObject({ allowed: true });
    const lead = await ctx.prisma.lead.create({
      data: {
        tenantId: dealer.tenantId,
        locationId: dealer.locationId,
        firstName: 'Synthetic',
        lastName: 'Restart',
        email: 'sfm2-restart@example.invalid',
        phone: VICTIM_E164,
        source: 'widget',
      },
    });
    const xml = await adfFor(lead.id);
    expect(xml).toMatch(/Consent: text=yes/);
    expect(xml).toContain('type="cellphone"');
  });
});
