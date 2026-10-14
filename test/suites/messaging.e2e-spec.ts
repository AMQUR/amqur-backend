import request from 'supertest';
import * as http from 'http';
import { AddressInfo } from 'net';
import {
  createE2eApp,
  E2eCtx,
  seedTwoTenants,
  unwrap,
} from '../helpers/e2e-app';
import { SecretVaultService } from '../../src/integrations/core/secret-vault.service';
import { MessagingService } from '../../src/messaging/messaging.service';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import { ConsentService } from '../../src/messaging/consent.service';
import {
  CampaignEngine,
  renderTemplate,
} from '../../src/messaging/campaign.engine';
import { twilioSignature } from '../../src/messaging/twilio';

const AUTH = 'test_auth_token_0123456789abcdef';
const PHONE = '+13125550188';

describe('messaging, consent ledger, campaigns (fake Twilio)', () => {
  let ctx: E2eCtx;
  let seed: Awaited<ReturnType<typeof seedTwoTenants>>;
  let fake: http.Server;
  const received: Array<Record<string, string>> = [];
  const prev = {
    base: process.env.TWILIO_API_BASE,
    pub: process.env.PUBLIC_API_BASE_URL,
    outbox: process.env.OUTBOX_PROCESSOR_ENABLED,
  };

  beforeAll(async () => {
    fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = Object.fromEntries(new URLSearchParams(body));
        received.push(p);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            sid: `SM${received.length.toString().padStart(32, '0')}`,
            status: 'queued',
          }),
        );
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    process.env.TWILIO_API_BASE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    process.env.PUBLIC_API_BASE_URL = 'https://api.amqur.test';
    process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
    ctx = await createE2eApp();
    seed = await seedTwoTenants(ctx.prisma);
    const tenantId = seed.alpha.tenant.id;
    await ctx.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        featureFlags: {
          chat: true,
          handoff: true,
          leadCapture: true,
          sms: true,
        },
      },
    });
    const vault = ctx.app.get(SecretVaultService);
    await ctx.prisma.integrationConnection.deleteMany({
      where: { tenantId, provider: 'TWILIO' },
    });
    await ctx.prisma.integrationConnection.create({
      data: {
        tenantId,
        provider: 'TWILIO',
        capability: 'messaging',
        enabled: true,
        liveReady: true,
        config: { environment: 'sandbox' },
        secrets: {
          create: [
            ['accountSid', 'ACtest'],
            ['authToken', AUTH],
            ['messagingServiceSid', 'MGtest'],
          ].map(([k, v]) => ({ keyName: k, ...vault.encrypt(v) })),
        },
      },
    });
    await ctx.prisma.location.update({
      where: { id: seed.alpha.location.id },
      data: { timezone: 'America/Chicago' },
    });
  });

  afterAll(async () => {
    await ctx.app.close();
    fake.close();
    process.env.TWILIO_API_BASE = prev.base;
    process.env.PUBLIC_API_BASE_URL = prev.pub;
    process.env.OUTBOX_PROCESSOR_ENABLED = prev.outbox;
  });

  const noon = () =>
    new Date(new Date().toISOString().slice(0, 10) + 'T18:00:00Z'); // 1pm CDT / 12pm CST

  it('no consent → suppressed; possession of a number is not consent', async () => {
    const r = await ctx.app.get(MessagingService).queue({
      tenantId: seed.alpha.tenant.id,
      locationId: seed.alpha.location.id,
      channel: 'SMS',
      to: '312-555-0199',
      body: 'hi',
      purpose: 'CONVERSATIONAL',
      now: noon(),
    });
    expect(r).toMatchObject({ status: 'SUPPRESSED', reason: 'no_consent' });
  });

  it('consented message is delivered via the provider; status webhook (signed) marks delivered; forged webhook ignored', async () => {
    const tenantId = seed.alpha.tenant.id;
    await ctx.app.get(ConsentService).record({
      tenantId,
      channel: 'SMS',
      endpoint: PHONE,
      purpose: 'CONVERSATIONAL',
      granted: true,
      source: 'WIDGET',
      wording: 'ok to text',
      wordingVersion: 't1',
    });
    const q = await ctx.app.get(MessagingService).queue({
      tenantId,
      locationId: seed.alpha.location.id,
      channel: 'SMS',
      to: PHONE,
      body: 'Your request is in.',
      purpose: 'CONVERSATIONAL',
      now: noon(),
      idempotencyKey: `t-${Date.now()}`,
    });
    expect(q.status).toBe('QUEUED');
    if (q.status !== 'QUEUED') return;
    await ctx.prisma.outboxEvent.updateMany({
      where: { topic: 'messaging.send' },
      data: { nextAttemptAt: new Date(0) },
    });
    await ctx.app.get(OutboxProcessorService).processBatch(500, 'msg-test');
    const sent = await ctx.prisma.outboundMessage.findUniqueOrThrow({
      where: { id: q.id },
    });
    expect(sent.status).toBe('SENT');
    expect(received.at(-1)).toMatchObject({
      To: PHONE,
      MessagingServiceSid: 'MGtest',
    });

    const path = '/api/webhooks/twilio/pilot-alpha/status';
    const params = {
      MessageSid: sent.providerMessageId!,
      MessageStatus: 'delivered',
    };
    const forged = await request(ctx.app.getHttpServer())
      .post(path)
      .type('form')
      .set('X-Twilio-Signature', 'bogus')
      .send(params);
    expect(unwrap<{ ok: boolean }>(forged.body).ok).toBe(false);
    const sig = twilioSignature(AUTH, `https://api.amqur.test${path}`, params);
    await request(ctx.app.getHttpServer())
      .post(path)
      .type('form')
      .set('X-Twilio-Signature', sig)
      .send(params)
      .expect(200);
    expect(
      (
        await ctx.prisma.outboundMessage.findUniqueOrThrow({
          where: { id: q.id },
        })
      ).status,
    ).toBe('DELIVERED');
  });

  it('inbound STOP revokes consent immediately; later sends are suppressed', async () => {
    const path = '/api/webhooks/twilio/pilot-alpha/sms';
    const params = {
      From: PHONE,
      To: '+18005550100',
      Body: 'STOP',
      MessageSid: 'SMinbound1',
    };
    const sig = twilioSignature(AUTH, `https://api.amqur.test${path}`, params);
    const r = await request(ctx.app.getHttpServer())
      .post(path)
      .type('form')
      .set('X-Twilio-Signature', sig)
      .send(params);
    expect(r.status).toBe(200);
    expect(r.text).toContain('<Response>');
    const q = await ctx.app.get(MessagingService).queue({
      tenantId: seed.alpha.tenant.id,
      locationId: seed.alpha.location.id,
      channel: 'SMS',
      to: PHONE,
      body: 'x',
      purpose: 'CONVERSATIONAL',
      now: noon(),
    });
    expect(q).toMatchObject({ status: 'SUPPRESSED', reason: 'opted_out' });
    // unsigned STOP from an attacker cannot opt someone back in or out
    const bad = await request(ctx.app.getHttpServer())
      .post(path)
      .type('form')
      .send({ ...params, Body: 'START' });
    expect(bad.status).toBe(403);
    expect(
      (
        await ctx.app
          .get(ConsentService)
          .status(seed.alpha.tenant.id, 'SMS', PHONE, 'CONVERSATIONAL')
      ).allowed,
    ).toBe(false);
  });

  it('quiet hours defer delivery to the next allowed time in the dealership timezone', async () => {
    const tenantId = seed.alpha.tenant.id;
    const phone = '+13125550166';
    await ctx.app.get(ConsentService).record({
      tenantId,
      channel: 'SMS',
      endpoint: phone,
      purpose: 'CONVERSATIONAL',
      granted: true,
      source: 'WIDGET',
    });
    const late = new Date('2026-10-14T04:00:00Z'); // 11pm CDT
    const q = await ctx.app.get(MessagingService).queue({
      tenantId,
      locationId: seed.alpha.location.id,
      channel: 'SMS',
      to: phone,
      body: 'x',
      purpose: 'CONVERSATIONAL',
      now: late,
      idempotencyKey: `quiet-${Date.now()}`,
    });
    expect(q.status).toBe('QUEUED');
    if (q.status === 'QUEUED')
      expect(q.deferredUntil).toBe('2026-10-14T13:00:00.000Z'); // 8am CDT
  });

  it('campaign: only approved template variables; versioned; stop conditions re-checked at send time', async () => {
    expect(
      renderTemplate('Hi {firstName}, see you {appointmentDate}', {
        firstName: 'Sam',
        appointmentDate: 'Sat',
      }),
    ).toBe('Hi Sam, see you Sat');
    expect(renderTemplate('Your rate is {apr}', {})).toBeNull();
    const admin = unwrap<{ access_token: string }>(
      (
        await request(ctx.app.getHttpServer()).post('/api/auth/login').send({
          email: 'admin@pilot-alpha.test',
          password: seed.alpha.password,
        })
      ).body,
    ).access_token;
    const bad = await request(ctx.app.getHttpServer())
      .post('/api/campaigns')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        name: `bad-${Date.now()}`,
        trigger: 'lead.no_response',
        channel: 'SMS',
        template: 'Price drop to {price}!',
      });
    expect(bad.status).toBe(400);
    const c = unwrap<{ id: string; enabled: boolean; version: number }>(
      (
        await request(ctx.app.getHttpServer())
          .post('/api/campaigns')
          .set('Authorization', `Bearer ${admin}`)
          .send({
            name: `reminder-${Date.now()}`,
            trigger: 'appointment.confirmed.reminder',
            channel: 'SMS',
            template:
              'Hi {firstName}, reminder of your visit {appointmentDate} at {appointmentTime}.',
          })
      ).body,
    );
    expect(c.enabled).toBe(false); // created disabled
    const on = unwrap<{ version: number }>(
      (
        await request(ctx.app.getHttpServer())
          .patch(`/api/campaigns/${c.id}`)
          .set('Authorization', `Bearer ${admin}`)
          .send({ enabled: true })
      ).body,
    );
    expect(on.version).toBe(c.version + 1);

    const tenantId = seed.alpha.tenant.id;
    const phone = '+13125550155';
    const conv = await ctx.prisma.conversation.create({
      data: { tenantId, externalKey: `camp-${Date.now()}` },
    });
    await ctx.app.get(ConsentService).record({
      tenantId,
      channel: 'SMS',
      endpoint: phone,
      purpose: 'TRANSACTIONAL',
      granted: true,
      source: 'WIDGET',
      conversationExternalKey: conv.externalKey,
    });
    const appt = await ctx.prisma.appointment.create({
      data: {
        tenantId,
        locationId: seed.alpha.location.id,
        conversationId: conv.id,
        type: 'SERVICE',
        status: 'REQUESTED',
        customerName: 'Sam Rivera',
        customerPhone: phone,
        requestedAt: new Date(Date.now() + 3 * 86_400_000),
        idempotencyKey: `camp-appt-${Date.now()}`,
      },
    });
    await request(ctx.app.getHttpServer())
      .post(`/api/appointments/${appt.id}/transition`)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        to: 'CONFIRMED',
        scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      })
      .expect(201);
    const step = await ctx.prisma.outboxEvent.findFirst({
      where: { topic: 'campaign.step', AND: [{ idempotencyKey: { contains: appt.id } }, { idempotencyKey: { contains: c.id } }] },
    });
    expect(step).toBeTruthy();
    expect(step!.nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + 86_400_000,
    ); // scheduled ~24h before the visit
    const engine = ctx.app.get(CampaignEngine);
    // customer replied after enrollment → stop
    await ctx.prisma.message.create({
      data: { conversationId: conv.id, role: 'USER', content: 'thanks!' },
    });
    expect(await engine.execute(step!.payload as never)).toEqual({
      note: 'stopped:customer_replied',
    });
    // campaign edited → in-flight step of the old version stops
    await request(ctx.app.getHttpServer())
      .patch(`/api/campaigns/${c.id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ template: 'Hi {firstName}, see you {appointmentDate}.' })
      .expect(200);
    expect(await engine.execute(step!.payload as never)).toEqual({
      note: 'stopped:campaign_changed',
    });
  });
});
