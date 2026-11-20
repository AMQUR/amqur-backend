import * as http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { DemoDealer, seedDemoDealer, SIM_ORIGIN } from '../helpers/demo-dealer';
import { ChatService } from '../../src/chat/chat.service';
import { referenceNow } from '../../src/common/time/reference-now';
import {
  SANDBOX_SCHEDULER_NAME,
  sandboxTakenSlotStart,
} from '../../src/appointments/sandbox-scheduling.adapter';
import { LEAD_FORM_CONSENT_VERSION } from '../../src/chat/sales-desk/consent-wording';
import { LEAD_SUBMITTED_MARKER } from '../../src/chat/sales-desk/lead-form';

/**
 * Server half of the widget ↔ backend contract added with POST /chat/stream and the
 * structured "sales desk" cards (see docs/CHAT_STREAM_CONTRACT.md). Synthetic data only:
 * example.invalid addresses and 555-01xx numbers.
 */
type Card = Record<string, unknown> & { kind: string };
type Chat = {
  reply: string;
  segments: string[];
  cards: Card[];
  vehicles?: Array<Record<string, unknown>>;
  journey: Record<string, unknown>;
  conversation: { pending: string; language: string };
  conversationId: string;
  conversationIdIssued?: boolean;
};
type StreamEvent = { type: string } & Record<string, unknown>;

const EMAIL = 'pat.rivera@example.invalid';
const PHONE = '(312) 555-0142';
const PHONE_DIGITS = '3125550142';

describe('chat stream + sales-desk cards', () => {
  let ctx: E2eCtx;
  let on: DemoDealer; // salesDeskCards on, no scheduler
  let off: DemoDealer; // flag off (today's contract)
  let sbx: DemoDealer; // salesDeskCards + sandbox scheduler
  let other: DemoDealer; // a different tenant with the sandbox too
  let sms: DemoDealer; // salesDeskCards + sms
  const tokens: Record<string, string> = {};
  const srv = () => request(ctx.app.getHttpServer());

  const tokenFor = async (d: DemoDealer) => {
    if (!tokens[d.slug]) {
      const r = await srv()
        .post('/api/public/widget-token')
        .set('Origin', SIM_ORIGIN)
        .send({ tenantSlug: d.slug, locationSlug: 'main' });
      tokens[d.slug] = unwrap<{ token: string }>(r.body).token;
    }
    return tokens[d.slug];
  };
  const post = async (d: DemoDealer, path: string, body: object) =>
    srv()
      .post(path)
      .set('Authorization', `Bearer ${await tokenFor(d)}`)
      .set('Origin', SIM_ORIGIN)
      .send(body);
  const chat = async (d: DemoDealer, body: object): Promise<Chat> => {
    const r = await post(d, '/api/chat', body);
    if (r.status >= 300) throw new Error(`chat ${r.status}: ${r.text}`);
    return unwrap<Chat>(r.body);
  };
  const parseSse = (text: string): StreamEvent[] =>
    text
      .split('\n\n')
      .map((f) =>
        f
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n'),
      )
      .filter(Boolean)
      .map((d) => JSON.parse(d) as StreamEvent);
  const card = <T = Card>(c: Chat, kind: string) =>
    c.cards.find((x) => x.kind === kind) as T | undefined;
  const conv = (d: DemoDealer, conversationId: string) =>
    ctx.prisma.conversation.findUniqueOrThrow({
      where: {
        tenantId_externalKey: {
          tenantId: d.tenantId,
          externalKey: conversationId,
        },
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  const contactOf = (state: unknown) =>
    (state as { contact: Record<string, unknown> }).contact;
  const lead = (formId: string, over: Record<string, unknown> = {}) => ({
    formId,
    firstName: 'Pat',
    lastName: 'Rivera',
    email: EMAIL,
    phone: PHONE,
    preferredChannel: 'EMAIL',
    consents: [
      { channel: 'EMAIL', granted: true, version: LEAD_FORM_CONSENT_VERSION },
      { channel: 'CALL', granted: true, version: LEAD_FORM_CONSENT_VERSION },
    ],
    ...over,
  });
  const vinOf = (d: DemoDealer) => d.vehicles[0].vin;

  /** Sandbox journey up to a provider-slot picker (contact first, then real slots). */
  const toSlotPicker = async (d: DemoDealer, language = 'en') => {
    const a = await chat(d, { action: 'test_drive', vin: vinOf(d), language });
    const form = card<{ id: string }>(a, 'lead_form')!;
    const b = await chat(d, {
      action: 'lead_capture',
      conversationId: a.conversationId,
      language,
      lead: lead(form.id),
    });
    const picker = card<{
      id: string;
      mode: string;
      sandbox?: boolean;
      rooftopName: string;
      timezone: string;
      slots: Array<{ id: string; start: string; expiresAt: string }>;
    }>(b, 'appointment_picker')!;
    return { conversationId: a.conversationId, first: a, afterLead: b, picker };
  };

  beforeAll(async () => {
    ctx = await createE2eApp();
    const base = { creditPreview: false };
    on = await seedDemoDealer(ctx.app, ctx.prisma, 'sd-cards-on', {
      ...base,
      flags: { salesDeskCards: true },
    });
    off = await seedDemoDealer(ctx.app, ctx.prisma, 'sd-cards-off', base);
    sms = await seedDemoDealer(ctx.app, ctx.prisma, 'sd-cards-sms', {
      ...base,
      flags: { salesDeskCards: true, sms: true },
    });
    sbx = await seedDemoDealer(ctx.app, ctx.prisma, 'sd-sandbox', {
      ...base,
      flags: { salesDeskCards: true, sandboxScheduler: true },
    });
    other = await seedDemoDealer(ctx.app, ctx.prisma, 'sd-sandbox-other', {
      ...base,
      flags: { salesDeskCards: true, sandboxScheduler: true },
    });
    for (const d of [sbx, other]) {
      await ctx.prisma.integrationConnection.deleteMany({
        where: { tenantId: d.tenantId, capability: 'appointments' },
      });
      await ctx.prisma.integrationConnection.create({
        data: {
          tenantId: d.tenantId,
          locationId: d.locationId,
          provider: 'MOCK',
          capability: 'appointments',
          enabled: true,
          liveReady: true,
          config: { mode: 'sandbox' },
        },
      });
      // Earlier runs against the same disposable database must not hold today's slots.
      await ctx.prisma.appointment.deleteMany({
        where: { tenantId: d.tenantId },
      });
    }
  }, 120_000);
  afterAll(async () => ctx.app.close());

  // ─────────────────────────────────────────── POST /chat/stream

  describe('POST /chat/stream', () => {
    const scrub = (v: unknown): unknown =>
      JSON.parse(
        JSON.stringify(v, (k, x: unknown) =>
          [
            'conversationId',
            'lastSeenAt',
            'inventoryAsOf',
            'sourceUpdatedAt',
            'asOf',
            'id',
            'minTypingMs',
            'maxTypingMs',
          ].includes(k)
            ? '<volatile>'
            : x,
        ),
      );

    it('streams turn.started → status → text → turn.completed, equal to POST /chat', async () => {
      const body = { message: 'Do you have any SUVs?', language: 'en' };
      const r = await post(on, '/api/chat/stream', body).then((x) => x);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('text/event-stream');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-accel-buffering']).toBe('no');
      const events = parseSse(r.text);
      const types = events.map((e) => e.type);
      expect(types[0]).toBe('turn.started');
      expect(types[types.length - 1]).toBe('turn.completed');
      expect(types.filter((t) => t === 'turn.completed')).toHaveLength(1);
      expect(types).not.toContain('turn.error');
      // a real status from the engine's inventory read, before any text
      expect(types.indexOf('status')).toBeGreaterThan(0);
      expect(types.indexOf('status')).toBeLessThan(types.indexOf('text.delta'));
      expect(events.find((e) => e.type === 'status')).toMatchObject({
        phase: 'checking',
        label: 'Checking inventory',
      });
      const started = events[0] as unknown as {
        turnId: string;
        conversationId: string;
        conversationIdIssued: boolean;
      };
      expect(started.turnId).toEqual(expect.any(String));
      expect(started.conversationId).toMatch(/^cv1\./);
      expect(started.conversationIdIssued).toBe(true);

      const response = events[events.length - 1].response as Chat;
      expect(response.conversationId).toBe(started.conversationId);
      // every segment is delivered as delta then done, in order, nothing invented
      const deltas = events.filter((e) => e.type === 'text.delta');
      expect(deltas.map((e) => e.text)).toEqual(response.segments);
      deltas.forEach((e, i) => {
        expect(e.index).toBe(i);
        expect(types[events.indexOf(e) + 1]).toBe('text.done');
      });
      // no JSON envelope around the stream
      expect(r.text).not.toContain('"success"');

      const plain = await chat(on, body);
      expect(scrub(response)).toEqual(scrub(plain));
      expect((response.vehicles ?? []).length).toBeGreaterThan(0);
    });

    it('auth, origin and validation failures stay plain JSON errors (no stream)', async () => {
      const noAuth = await srv()
        .post('/api/chat/stream')
        .set('Origin', SIM_ORIGIN)
        .send({ message: 'hi' });
      expect(noAuth.status).toBe(401);
      expect(noAuth.headers['content-type']).toContain('application/json');
      expect(noAuth.body.success).toBe(false);

      const badOrigin = await srv()
        .post('/api/chat/stream')
        .set('Authorization', `Bearer ${await tokenFor(on)}`)
        .set('Origin', 'https://evil.example.invalid')
        .send({ message: 'hi' });
      const plainBadOrigin = await srv()
        .post('/api/chat')
        .set('Authorization', `Bearer ${await tokenFor(on)}`)
        .set('Origin', 'https://evil.example.invalid')
        .send({ message: 'hi' });
      // the token is origin-bound: same rejection as POST /chat, as an ordinary HTTP error
      expect([401, 403]).toContain(plainBadOrigin.status);
      expect(badOrigin.status).toBe(plainBadOrigin.status);
      expect(badOrigin.body).toMatchObject({
        success: false,
        message: plainBadOrigin.body.message,
      });
      expect(badOrigin.headers['content-type']).toContain('application/json');

      const invalid = await post(on, '/api/chat/stream', {
        message: 'hi',
        tenantId: 'someone-else',
      });
      expect(invalid.status).toBe(400);
      expect(invalid.headers['content-type']).toContain('application/json');
    });

    it('a failure after the stream started is a customer-safe turn.error', async () => {
      const spy = jest
        .spyOn(ctx.app.get(ChatService), 'chat')
        .mockRejectedValueOnce(
          new Error('db exploded at 10.0.0.7 pat@example.invalid'),
        );
      try {
        const r = await post(on, '/api/chat/stream', { message: 'hello' });
        expect(r.status).toBe(200);
        const events = parseSse(r.text);
        expect(events.map((e) => e.type)).toEqual([
          'turn.started',
          'turn.error',
        ]);
        expect(events[1]).toMatchObject({
          code: 'turn_failed',
          retryable: true,
        });
        expect(String(events[1].message).length).toBeLessThan(160);
        expect(r.text).not.toMatch(
          /exploded|10\.0\.0\.7|example\.invalid|Error|\bat \w+ \(/,
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('a client that disconnects mid-stream still gets a fully persisted turn', async () => {
      const address = (
        ctx.app.getHttpServer() as import('http').Server
      ).address() as AddressInfo;
      const token = await tokenFor(on);
      const svc = ctx.app.get(ChatService);
      const original = svc.chat.bind(svc);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      // Hold the engine until the client is gone, then let the real turn run.
      const spy = jest.spyOn(svc, 'chat').mockImplementationOnce(async (i) => {
        await gate;
        try {
          return await original(i);
        } finally {
          setTimeout(done, 50);
        }
      });
      const payload = JSON.stringify({ message: 'What are your hours?' });
      const conversationId = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/chat/stream',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
              Authorization: `Bearer ${token}`,
              Origin: SIM_ORIGIN,
            },
          },
          (res) => {
            res.once('data', (chunk: Buffer) => {
              const [started] = parseSse(chunk.toString('utf8'));
              req.destroy(); // client walks away right after turn.started
              resolve(String(started.conversationId));
            });
          },
        );
        req.on('error', (e: NodeJS.ErrnoException) => {
          if (e.code !== 'ECONNRESET') reject(e);
        });
        req.end(payload);
      });
      await new Promise((r) => setTimeout(r, 100));
      release();
      await finished;
      spy.mockRestore();

      const c = await conv(on, conversationId);
      expect(c.messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT']);
      expect(c.messages[1].content.length).toBeGreaterThan(0);
      expect((c.state as { turnCount: number }).turnCount).toBe(1);
      // and the conversation is usable afterwards
      const next = await chat(on, { message: 'thanks', conversationId });
      expect(next.conversationId).toBe(conversationId);
      expect(next.conversationIdIssued).toBe(false);
    });
  });

  // ─────────────────────────────────────────── request DTO

  describe('request validation', () => {
    const picker = { pickerId: 'pk_aaaaaaaaaaaaaaaa' };
    const bad: Array<[string, object]> = [
      ['lead without action', { message: 'x', lead: lead('lf_aaaaaaaaaaaa') }],
      [
        'lead with another action',
        { action: 'test_drive', lead: lead('lf_aaaaaaaaaaaa') },
      ],
      [
        'appointment with another action',
        { action: 'lead_capture', appointment: picker },
      ],
      [
        'sensitive extra field in lead',
        {
          action: 'lead_capture',
          lead: { ...lead('lf_aaaaaaaaaaaa'), ssn: '000-00-0000' },
        },
      ],
      [
        'date of birth in lead',
        {
          action: 'lead_capture',
          lead: { ...lead('lf_aaaaaaaaaaaa'), dateOfBirth: '1990-01-01' },
        },
      ],
      [
        'oversize name',
        {
          action: 'lead_capture',
          lead: lead('lf_aaaaaaaaaaaa', { firstName: 'x'.repeat(61) }),
        },
      ],
      [
        'unknown channel',
        {
          action: 'lead_capture',
          lead: lead('lf_aaaaaaaaaaaa', { preferredChannel: 'FAX' }),
        },
      ],
      [
        'too many consents',
        {
          action: 'lead_capture',
          lead: lead('lf_aaaaaaaaaaaa', {
            consents: Array.from({ length: 4 }, () => ({
              channel: 'EMAIL',
              granted: true,
              version: 'v',
            })),
          }),
        },
      ],
      [
        'client-supplied tenant in appointment',
        {
          action: 'appointment_select',
          appointment: { ...picker, tenantId: 'x' },
        },
      ],
      [
        'malformed date',
        {
          action: 'appointment_select',
          appointment: {
            ...picker,
            requestedDate: 'tomorrow',
            requestedWindow: 'morning',
          },
        },
      ],
      [
        'unknown window',
        {
          action: 'appointment_select',
          appointment: {
            ...picker,
            requestedDate: '2026-10-14',
            requestedWindow: 'midnight',
          },
        },
      ],
      [
        'malformed slot id',
        {
          action: 'appointment_select',
          appointment: { ...picker, slotId: 'DROP TABLE' },
        },
      ],
    ];
    it.each(bad)('400: %s', async (_name, body) => {
      for (const path of ['/api/chat', '/api/chat/stream']) {
        const r = await post(on, path, body);
        expect(r.status).toBe(400);
        expect(r.body.success).toBe(false);
      }
    });
  });

  // ─────────────────────────────────────────── flag off

  describe('salesDeskCards OFF — today’s contract, nothing new', () => {
    it('no new cards or fields; structured payloads are refused and store nothing', async () => {
      const a = await chat(off, { action: 'test_drive', vin: vinOf(off) });
      expect(a.conversation.pending).toBe('appointment_date');
      expect(a.cards).toEqual([]);
      const b = await chat(off, {
        message: 'Friday morning',
        conversationId: a.conversationId,
      });
      expect(b.cards).toHaveLength(1);
      // exactly the pre-existing appointment card shape
      expect(Object.keys(b.cards[0]).sort()).toEqual(
        [
          'date',
          'id',
          'kind',
          'label',
          'outcome',
          'status',
          'time',
          'type',
          'verified',
        ].sort(),
      );
      expect(b.conversation.pending).toBe('contact_name');

      const v = await chat(off, { message: 'Do you have any SUVs?' });
      expect(v.vehicles!.length).toBeGreaterThan(0);
      for (const x of v.vehicles!) {
        expect(x).not.toHaveProperty('rooftopName');
        expect(x).not.toHaveProperty('vdpUrl');
        expect(x).not.toHaveProperty('priceIncludesDealerFees');
      }

      const c = await chat(off, {
        action: 'lead_capture',
        conversationId: a.conversationId,
        lead: lead('lf_aaaaaaaaaaaa'),
      });
      expect(card(c, 'lead_form')).toBeUndefined();
      expect(c.reply).toMatch(/haven’t saved anything/);
      const row = await conv(off, a.conversationId);
      expect(contactOf(row.state)).toEqual({});
      expect(
        await ctx.prisma.consentRecord.count({
          where: { tenantId: off.tenantId },
        }),
      ).toBe(0);
      expect(
        await ctx.prisma.lead.count({
          where: { tenantId: off.tenantId, conversationId: row.id },
        }),
      ).toBe(0);
    });
  });

  // ─────────────────────────────────────────── flag on, no scheduler

  describe('salesDeskCards ON, no scheduler — request-only', () => {
    let conversationId: string;
    let formId: string;
    let appointmentId: string;

    it('the date question carries a request_only picker for this rooftop', async () => {
      const a = await chat(on, { action: 'test_drive', vin: vinOf(on) });
      conversationId = a.conversationId;
      expect(a.conversation.pending).toBe('appointment_date');
      expect(a.reply).toMatch(/What day works/);
      const p = card<Record<string, unknown>>(a, 'appointment_picker')!;
      expect(p).toMatchObject({
        mode: 'request_only',
        department: 'sales',
        purpose: 'Test drive',
        rooftopName: 'sd-cards-on main',
        timezone: 'America/Chicago',
        vin: vinOf(on),
      });
      expect(p).not.toHaveProperty('slots');
      expect(p).not.toHaveProperty('sandbox');
      expect(p).not.toHaveProperty('externalUrl');
      // next open days in the store timezone (reference clock: Tue 2026-10-13), Sunday closed
      expect(p.days).toEqual([
        '2026-10-14',
        '2026-10-15',
        '2026-10-16',
        '2026-10-17',
        '2026-10-19',
      ]);
    });

    it('a day that was not offered is refused and nothing is requested', async () => {
      const a = await chat(on, { action: 'test_drive', vin: vinOf(on) });
      const p = card<{ id: string }>(a, 'appointment_picker')!;
      const r = await chat(on, {
        action: 'appointment_select',
        conversationId: a.conversationId,
        appointment: {
          pickerId: p.id,
          requestedDate: '2027-01-01',
          requestedWindow: 'morning',
        },
      });
      expect(card(r, 'appointment')).toBeUndefined();
      expect(card(r, 'appointment_picker')).toBeDefined();
      expect(r.reply).toMatch(/nothing was sent/);
      const row = await conv(on, a.conversationId);
      expect(
        await ctx.prisma.appointment.count({
          where: { conversationId: row.id },
        }),
      ).toBe(0);
    });

    it('day + window goes down the request path: REQUESTED, never confirmed', async () => {
      const first = await chat(on, { message: 'thanks', conversationId });
      void first;
      const again = await chat(on, {
        action: 'test_drive',
        vin: vinOf(on),
        conversationId,
      });
      const p = card<{ id: string; days: string[] }>(
        again,
        'appointment_picker',
      )!;
      const r = await chat(on, {
        action: 'appointment_select',
        conversationId,
        appointment: {
          pickerId: p.id,
          requestedDate: p.days[1],
          requestedWindow: 'afternoon',
        },
      });
      const appt = card<Record<string, unknown>>(r, 'appointment')!;
      expect(appt).toMatchObject({
        status: 'REQUESTED',
        outcome: 'requested',
        verified: false,
        date: p.days[1],
        time: 'afternoon',
        rooftopName: 'sd-cards-on main',
        department: 'Sales',
        timezone: 'America/Chicago',
      });
      expect(appt).not.toHaveProperty('providerRef');
      expect(appt).not.toHaveProperty('providerName');
      expect(appt).not.toHaveProperty('startsAt');
      expect(appt).not.toHaveProperty('sandbox');
      expect(r.reply).toMatch(/request for now/);
      appointmentId = String(appt.id);
      const row = await ctx.prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
      });
      expect(row.status).toBe('REQUESTED');
      expect(row.provider).toBe('NONE');
      expect(row.availabilityVerified).toBe(false);
      expect(
        await ctx.prisma.appointmentProviderReceipt.count({
          where: { appointmentId },
        }),
      ).toBe(0);

      // the engine now asks who to ask for → the lead form rides along
      expect(r.conversation.pending).toBe('contact_name');
      const f = card<Record<string, unknown>>(r, 'lead_form')!;
      formId = String(f.id);
      expect(f).toMatchObject({
        purpose: 'test_drive',
        rooftopName: 'sd-cards-on main',
        vin: vinOf(on),
        channels: ['EMAIL', 'CALL'], // sms is off for this rooftop → no TEXT
      });
      const consent = f.consent as {
        version: string;
        text: Record<string, string>;
      };
      expect(consent.version).toBe(LEAD_FORM_CONSENT_VERSION);
      expect(Object.keys(consent.text).sort()).toEqual(['CALL', 'EMAIL']);

      // submitting the same choice again is a no-op, not a second appointment
      const dup = await chat(on, {
        action: 'appointment_select',
        conversationId,
        appointment: {
          pickerId: p.id,
          requestedDate: p.days[1],
          requestedWindow: 'afternoon',
        },
      });
      expect(dup.reply).toMatch(/already in/);
      const c = await conv(on, conversationId);
      expect(
        await ctx.prisma.appointment.count({ where: { conversationId: c.id } }),
      ).toBe(1);
    });

    it('a submission without consent for the preferred channel stores nothing', async () => {
      const r = await chat(on, {
        action: 'lead_capture',
        conversationId,
        lead: lead(formId, {
          consents: [
            {
              channel: 'EMAIL',
              granted: false,
              version: LEAD_FORM_CONSENT_VERSION,
            },
            {
              channel: 'CALL',
              granted: true,
              version: LEAD_FORM_CONSENT_VERSION,
            },
          ],
        }),
      });
      expect(r.reply).toMatch(/haven’t saved anything/);
      // the same form is offered again
      expect(card<{ id: string }>(r, 'lead_form')!.id).toBe(formId);
      const c = await conv(on, conversationId);
      expect(contactOf(c.state)).toEqual({});
      expect(
        await ctx.prisma.consentRecord.count({
          where: {
            tenantId: on.tenantId,
            conversationExternalKey: conversationId,
          },
        }),
      ).toBe(0);
      expect(
        await ctx.prisma.lead.count({ where: { conversationId: c.id } }),
      ).toBe(0);
      const appt = await ctx.prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
      });
      expect(appt.customerEmail).toBeNull();
      expect(appt.customerPhone).toBeNull();
    });

    it('an unrecognised consent version, a forged form id and a bad phone are refused', async () => {
      for (const over of [
        {
          consents: [
            { channel: 'EMAIL', granted: true, version: 'made-up-v9' },
          ],
        },
        { formId: 'lf_forged_form_id_0001' },
        { phone: '555-0142', preferredChannel: 'CALL' }, // not a 10-digit US number
        { preferredChannel: 'TEXT' }, // not offered here
      ]) {
        const r = await chat(on, {
          action: 'lead_capture',
          conversationId,
          lead: lead(formId, over),
        });
        expect(r.reply).toMatch(/haven’t saved anything/);
      }
      const c = await conv(on, conversationId);
      expect(contactOf(c.state)).toEqual({});
      expect(
        await ctx.prisma.consentRecord.count({
          where: {
            tenantId: on.tenantId,
            conversationExternalKey: conversationId,
          },
        }),
      ).toBe(0);
    });

    it('with consent: exact consent rows, one lead, neutral transcript, no PII in logs', async () => {
      const written: string[] = [];
      const capture = (chunk: unknown) => {
        written.push(String(chunk));
        return true;
      };
      const out = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(capture);
      const err = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(capture);
      const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
        (m) =>
          jest.spyOn(console, m).mockImplementation((...a: unknown[]) => {
            written.push(
              a.map((x) => JSON.stringify(x) ?? String(x)).join(' '),
            );
          }),
      );
      let r: Chat;
      try {
        r = await chat(on, {
          action: 'lead_capture',
          conversationId,
          // only EMAIL is ticked: the phone has no granted channel and must not be kept
          lead: lead(formId, {
            consents: [
              {
                channel: 'EMAIL',
                granted: true,
                version: LEAD_FORM_CONSENT_VERSION,
              },
              {
                channel: 'CALL',
                granted: false,
                version: LEAD_FORM_CONSENT_VERSION,
              },
            ],
          }),
        });
        // let fire-and-forget analytics/outbox writes log, if they are going to
        await new Promise((x) => setTimeout(x, 300));
      } finally {
        out.mockRestore();
        err.mockRestore();
        consoles.forEach((c) => c.mockRestore());
      }
      const logs = written.join('\n');
      // the request itself was logged (so the capture is real) — without any contact detail
      expect(logs).toContain('/api/chat');
      expect(logs).not.toContain(EMAIL);
      expect(logs).not.toContain(PHONE);
      expect(logs).not.toContain(PHONE_DIGITS);

      expect(r.reply).toMatch(/added that so the team can reach you/);
      expect(card(r, 'lead_form')).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain(EMAIL);

      const c = await conv(on, conversationId);
      expect(contactOf(c.state)).toEqual({
        firstName: 'Pat',
        lastName: 'Rivera',
        email: EMAIL,
        preferredContact: 'email',
      });
      const consents = await ctx.prisma.consentRecord.findMany({
        where: {
          tenantId: on.tenantId,
          conversationExternalKey: conversationId,
        },
      });
      expect(consents).toHaveLength(1);
      expect(consents[0]).toMatchObject({
        channel: 'EMAIL',
        endpoint: EMAIL,
        granted: true,
        purpose: 'CONVERSATIONAL',
        source: 'WIDGET',
        wordingVersion: LEAD_FORM_CONSENT_VERSION,
        wording: 'OK for the dealership to email me about this request.',
        tenantId: on.tenantId,
        locationId: on.locationId,
      });
      expect(consents[0].evidence).toMatchObject({
        capturedVia: 'lead_form',
        formId,
        preferredChannel: 'EMAIL',
      });

      // same downstream propagation as the conversational path
      const appt = await ctx.prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
      });
      expect(appt.customerName).toBe('Pat Rivera');
      expect(appt.customerEmail).toBe(EMAIL);
      expect(appt.customerPhone).toBeNull();
      const leads = await ctx.prisma.lead.findMany({
        where: { conversationId: c.id },
      });
      expect(leads).toHaveLength(1);
      expect(leads[0]).toMatchObject({
        firstName: 'Pat',
        email: EMAIL,
        phone: null,
        preferredContact: 'email',
      });
      expect(appt.leadId).toBe(leads[0].id);

      // transcript: a neutral marker, never the contact details
      const users = c.messages.filter((m) => m.role === 'USER');
      expect(users[users.length - 1].content).toBe(LEAD_SUBMITTED_MARKER);
      for (const m of c.messages) {
        expect(m.content).not.toContain(EMAIL);
        expect(m.content).not.toContain(PHONE_DIGITS);
        expect(JSON.stringify(m.metadata ?? {})).not.toContain(EMAIL);
      }
      const events = await ctx.prisma.analyticsEvent.findMany({
        where: { tenantId: on.tenantId },
      });
      expect(JSON.stringify(events)).not.toContain(EMAIL);
      expect(JSON.stringify(events)).not.toContain(PHONE_DIGITS);
    });

    it('a double submit keeps one lead and one consent row', async () => {
      const r = await chat(on, {
        action: 'lead_capture',
        conversationId,
        lead: lead(formId),
      });
      expect(r.reply).toMatch(/already have your details/);
      const c = await conv(on, conversationId);
      expect(
        await ctx.prisma.lead.count({ where: { conversationId: c.id } }),
      ).toBe(1);
      expect(
        await ctx.prisma.consentRecord.count({
          where: {
            tenantId: on.tenantId,
            conversationExternalKey: conversationId,
          },
        }),
      ).toBe(1);
    });

    it('TEXT is offered only where SMS is enabled, and is recorded on the SMS ledger', async () => {
      const a = await chat(sms, { action: 'test_drive', vin: vinOf(sms) });
      const p = card<{ id: string; days: string[] }>(a, 'appointment_picker')!;
      const b = await chat(sms, {
        action: 'appointment_select',
        conversationId: a.conversationId,
        appointment: {
          pickerId: p.id,
          requestedDate: p.days[0],
          requestedWindow: 'morning',
        },
      });
      const f = card<{
        id: string;
        channels: string[];
        consent: { text: Record<string, string> };
      }>(b, 'lead_form')!;
      expect(f.channels).toEqual(['EMAIL', 'CALL', 'TEXT']);
      expect(f.consent.text.TEXT).toMatch(/reply STOP anytime/);
      await chat(sms, {
        action: 'lead_capture',
        conversationId: a.conversationId,
        lead: lead(f.id, {
          preferredChannel: 'TEXT',
          consents: [
            {
              channel: 'TEXT',
              granted: true,
              version: LEAD_FORM_CONSENT_VERSION,
            },
          ],
        }),
      });
      const rows = await ctx.prisma.consentRecord.findMany({
        where: {
          tenantId: sms.tenantId,
          conversationExternalKey: a.conversationId,
        },
      });
      expect(rows.map((x) => [x.channel, x.endpoint, x.granted])).toEqual([
        ['SMS', '+13125550142', true],
      ]);
      const c = await conv(sms, a.conversationId);
      expect(contactOf(c.state)).toMatchObject({
        phone: PHONE_DIGITS,
        preferredContact: 'sms',
        consentToText: true,
      });
      expect(contactOf(c.state)).not.toHaveProperty('email');
    });

    it('Spanish: picker and lead form are localised, same versions', async () => {
      const a = await chat(on, {
        action: 'test_drive',
        vin: vinOf(on),
        language: 'es',
      });
      const p = card<Record<string, unknown> & { id: string; days: string[] }>(
        a,
        'appointment_picker',
      )!;
      expect(p.purpose).toBe('Prueba de manejo');
      const b = await chat(on, {
        action: 'appointment_select',
        conversationId: a.conversationId,
        language: 'es',
        appointment: {
          pickerId: p.id,
          requestedDate: p.days[0],
          requestedWindow: 'morning',
        },
      });
      expect(card<Record<string, unknown>>(b, 'appointment')).toMatchObject({
        outcome: 'requested',
        verified: false,
        department: 'Ventas',
      });
      const f = card<{
        reason: string;
        consent: { version: string; text: Record<string, string> };
      }>(b, 'lead_form')!;
      expect(f.consent.version).toBe(LEAD_FORM_CONSENT_VERSION);
      expect(f.consent.text.EMAIL).toBe(
        'Está bien que la agencia me envíe correos sobre esta solicitud.',
      );
      expect(f.reason).toMatch(/confirmar su visita/);
    });

    it('vehicles carry the owning rooftop; no guessed listing URL or fee claim', async () => {
      const v = await chat(on, { message: 'Do you have any SUVs?' });
      expect(v.vehicles!.length).toBeGreaterThan(0);
      for (const x of v.vehicles!) {
        expect(x.rooftopName).toBe('sd-cards-on main');
        expect(x.vdpUrl).toBeNull();
        expect(x.priceIncludesDealerFees).toBeNull();
      }
    });
  });

  // ─────────────────────────────────────────── sandbox scheduler

  describe('sandbox scheduler — provider slots', () => {
    it('asks who is booking first, then offers labelled sandbox slots', async () => {
      const j = await toSlotPicker(sbx);
      expect(j.first.conversation.pending).toBe('contact_name');
      expect(card(j.first, 'appointment_picker')).toBeUndefined();
      expect(j.afterLead.conversation.pending).toBe('appointment_date');
      expect(j.picker).toMatchObject({
        mode: 'provider_slots',
        sandbox: true,
        rooftopName: 'sd-sandbox main',
        timezone: 'America/Chicago',
      });
      expect(j.picker).not.toHaveProperty('days');
      expect(j.picker.slots.length).toBeGreaterThanOrEqual(8);
      for (const s of j.picker.slots) {
        expect(s.id).toMatch(/^sl_/);
        expect(Date.parse(s.start)).toBeGreaterThan(referenceNow().getTime());
        expect(Date.parse(s.expiresAt)).toBeGreaterThan(
          referenceNow().getTime(),
        );
      }
    });

    it('booking a slot: CONFIRMED only from the adapter receipt', async () => {
      const j = await toSlotPicker(sbx);
      const slot = j.picker.slots[0];
      const r = await chat(sbx, {
        action: 'appointment_select',
        conversationId: j.conversationId,
        appointment: { pickerId: j.picker.id, slotId: slot.id },
      });
      const a = card<Record<string, string>>(r, 'appointment')!;
      expect(a).toMatchObject({
        status: 'CONFIRMED',
        outcome: 'confirmed',
        verified: true,
        providerName: SANDBOX_SCHEDULER_NAME,
        startsAt: slot.start,
        timezone: 'America/Chicago',
        rooftopName: 'sd-sandbox main',
        department: 'Sales',
        sandbox: true,
      });
      expect(a.providerRef).toMatch(/^SBX-/);
      expect(r.reply).toMatch(/sandbox scheduler confirmed/i);
      expect(r.reply).toMatch(/demo booking, not a real appointment/);
      expect(card(r, 'appointment_picker')).toBeUndefined();

      const row = await ctx.prisma.appointment.findUniqueOrThrow({
        where: { id: a.id },
        include: { providerReceipts: true },
      });
      expect(row).toMatchObject({
        status: 'CONFIRMED',
        provider: 'MOCK',
        externalProviderId: a.providerRef,
        availabilityVerified: true,
        customerName: 'Pat Rivera',
      });
      expect(row.scheduledAt!.toISOString()).toBe(slot.start);
      expect(row.providerReceipts).toHaveLength(1);
      expect(row.providerReceipts[0]).toMatchObject({
        tenantId: sbx.tenantId,
        provider: 'MOCK',
        providerRef: a.providerRef,
        status: 'CONFIRMED',
        rawStatus: 'SANDBOX_CONFIRMED',
        sandbox: true,
        idempotencyKey: row.idempotencyKey,
      });
      expect(row.providerReceipts[0].confirmedStart!.toISOString()).toBe(
        slot.start,
      );

      // selecting the same slot again returns the same booking, not a second one
      const again = await chat(sbx, {
        action: 'appointment_select',
        conversationId: j.conversationId,
        appointment: { pickerId: j.picker.id, slotId: slot.id },
      });
      expect(card<Record<string, string>>(again, 'appointment')).toMatchObject({
        id: a.id,
        providerRef: a.providerRef,
        outcome: 'confirmed',
      });
      expect(
        await ctx.prisma.appointmentProviderReceipt.count({
          where: { tenantId: sbx.tenantId, providerRef: a.providerRef },
        }),
      ).toBe(1);

      // a slot one customer holds is not offered to the next one
      const next = await toSlotPicker(sbx);
      expect(next.picker.slots.map((s) => s.start)).not.toContain(slot.start);
    });

    it('the slot the provider rejects is never confirmed; a fresh picker comes back', async () => {
      const j = await toSlotPicker(sbx);
      const taken = j.picker.slots.find(
        (s) => s.start === sandboxTakenSlotStart(referenceNow()),
      )!;
      expect(taken).toBeDefined();
      const r = await chat(sbx, {
        action: 'appointment_select',
        conversationId: j.conversationId,
        appointment: { pickerId: j.picker.id, slotId: taken.id },
      });
      expect(card(r, 'appointment')).toBeUndefined();
      expect(r.reply).toMatch(/just taken, so nothing was booked/);
      expect(r.reply).not.toMatch(/confirmed|booked for/i);
      const fresh = card<{ id: string; mode: string }>(
        r,
        'appointment_picker',
      )!;
      expect(fresh.mode).toBe('provider_slots');
      expect(fresh.id).not.toBe(j.picker.id);
      expect(r.journey.appointment ?? null).toBeNull();

      const c = await conv(sbx, j.conversationId);
      const rows = await ctx.prisma.appointment.findMany({
        where: { conversationId: c.id },
        include: { providerReceipts: true },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('CANCELLED');
      expect(rows[0].providerReceipts.map((x) => x.status)).toEqual([
        'UNAVAILABLE',
      ]);
      expect(rows[0].providerReceipts[0].providerRef).toBeNull();
    });

    it('two concurrent selections of one slot yield exactly one confirmation', async () => {
      const j = await toSlotPicker(sbx);
      const slot = j.picker.slots[j.picker.slots.length - 1];
      const body = {
        action: 'appointment_select',
        conversationId: j.conversationId,
        appointment: { pickerId: j.picker.id, slotId: slot.id },
      };
      const [x, y] = await Promise.all([chat(sbx, body), chat(sbx, body)]);
      const confirmed = [x, y]
        .map((r) => card<Record<string, string>>(r, 'appointment'))
        .filter((a) => a?.outcome === 'confirmed');
      expect(confirmed.length).toBeGreaterThanOrEqual(1);
      expect(new Set(confirmed.map((a) => a!.id)).size).toBe(1);
      const c = await conv(sbx, j.conversationId);
      const rows = await ctx.prisma.appointment.findMany({
        where: { conversationId: c.id },
        include: { providerReceipts: true },
      });
      expect(rows.filter((a) => a.status === 'CONFIRMED')).toHaveLength(1);
      expect(
        rows
          .flatMap((a) => a.providerReceipts)
          .filter((p) => p.status === 'CONFIRMED'),
      ).toHaveLength(1);
    });

    it('forged, expired and other-tenant slot ids are refused; nothing is booked', async () => {
      const j = await toSlotPicker(sbx);
      const before = await ctx.prisma.appointment.count({
        where: { tenantId: sbx.tenantId },
      });
      const refuse = async (d: DemoDealer, body: object) => {
        const r = await chat(d, body);
        expect(card(r, 'appointment')).toBeUndefined();
        expect(r.reply).toMatch(/nothing was booked/);
        return r;
      };
      // forged slot id on a real picker
      await refuse(sbx, {
        action: 'appointment_select',
        conversationId: j.conversationId,
        appointment: { pickerId: j.picker.id, slotId: 'sl_forgedforgedforged' },
      });
      // forged picker id
      await refuse(sbx, {
        action: 'appointment_select',
        conversationId: j.conversationId,
        appointment: {
          pickerId: 'pk_forgedforgedforged',
          slotId: j.picker.slots[2].id,
        },
      });
      // a day/window on a provider-slot picker
      await refuse(sbx, {
        action: 'appointment_select',
        conversationId: j.conversationId,
        appointment: {
          pickerId: j.picker.id,
          requestedDate: '2026-10-15',
          requestedWindow: 'morning',
        },
      });
      // another conversation of the same tenant cannot use this conversation's slot
      const stranger = await toSlotPicker(sbx);
      await refuse(sbx, {
        action: 'appointment_select',
        conversationId: stranger.conversationId,
        appointment: { pickerId: j.picker.id, slotId: j.picker.slots[2].id },
      });
      // another TENANT cannot select it, and never sees this rooftop's name
      const foreign = await toSlotPicker(other);
      const leak = await refuse(other, {
        action: 'appointment_select',
        conversationId: foreign.conversationId,
        appointment: { pickerId: j.picker.id, slotId: j.picker.slots[2].id },
      });
      expect(JSON.stringify(leak)).not.toContain('sd-sandbox main');
      // …nor can it address the conversation itself (a new one is issued instead)
      const hijack = await chat(other, {
        action: 'appointment_select',
        conversationId: j.conversationId,
        appointment: { pickerId: j.picker.id, slotId: j.picker.slots[2].id },
      });
      expect(hijack.conversationIdIssued).toBe(true);
      expect(hijack.conversationId).not.toBe(j.conversationId);
      expect(card(hijack, 'appointment')).toBeUndefined();
      expect(JSON.stringify(hijack)).not.toContain('sd-sandbox main');

      // expired: the offer window (15 min) has passed
      const pinned = process.env.CHAT_REFERENCE_NOW;
      process.env.CHAT_REFERENCE_NOW = new Date(
        referenceNow().getTime() + 16 * 60_000,
      ).toISOString();
      try {
        const r = await chat(sbx, {
          action: 'appointment_select',
          conversationId: j.conversationId,
          appointment: { pickerId: j.picker.id, slotId: j.picker.slots[2].id },
        });
        expect(card(r, 'appointment')).toBeUndefined();
        expect(r.reply).toMatch(/no longer on offer, so nothing was booked/);
        expect(card(r, 'appointment_picker')).toBeDefined();
      } finally {
        if (pinned === undefined) delete process.env.CHAT_REFERENCE_NOW;
        else process.env.CHAT_REFERENCE_NOW = pinned;
      }

      expect(
        await ctx.prisma.appointment.count({
          where: { tenantId: sbx.tenantId },
        }),
      ).toBe(before);
      expect(
        await ctx.prisma.appointment.count({
          where: { tenantId: other.tenantId },
        }),
      ).toBe(0);
    });

    it('Spanish confirmation is labelled as a demo booking too', async () => {
      const j = await toSlotPicker(sbx, 'es');
      const r = await chat(sbx, {
        action: 'appointment_select',
        conversationId: j.conversationId,
        language: 'es',
        appointment: { pickerId: j.picker.id, slotId: j.picker.slots[3].id },
      });
      expect(card<Record<string, unknown>>(r, 'appointment')).toMatchObject({
        outcome: 'confirmed',
        sandbox: true,
        department: 'Ventas',
      });
      expect(r.reply).toMatch(/reserva de prueba, no una cita real/);
    });

    it('the sandbox flag alone (no enabled connection) gives no slots', async () => {
      // `on` has no MOCK appointments connection → request-only (asserted above); and a
      // connection without the flag is ignored too.
      await ctx.prisma.tenant.update({
        where: { id: other.tenantId },
        data: {
          featureFlags: {
            chat: true,
            inventory: true,
            leadCapture: true,
            appointments: true,
            salesDeskCards: true,
            sandboxScheduler: false,
          },
        },
      });
      const a = await chat(other, { action: 'test_drive', vin: vinOf(other) });
      expect(card<{ mode: string }>(a, 'appointment_picker')!.mode).toBe(
        'request_only',
      );
    });
  });

  // ─────────────────────────────────────────── branding theme

  describe('widget-config branding.theme', () => {
    const theme = async (d: DemoDealer) => {
      const r = await srv()
        .get(`/api/public/widget-config?tenantSlug=${d.slug}&locationSlug=main`)
        .set('Origin', SIM_ORIGIN);
      return unwrap<{ branding: { theme: unknown } }>(r.body).branding.theme;
    };
    it('defaults to null, exposes an allow-listed value, drops anything else', async () => {
      expect(await theme(off)).toBeNull();
      await ctx.prisma.tenant.update({
        where: { id: on.tenantId },
        data: {
          publicConfig: { theme: 'showroom' },
          configVersion: { increment: 1 },
        },
      });
      expect(await theme(on)).toBe('showroom');
      await ctx.prisma.tenant.update({
        where: { id: sms.tenantId },
        data: {
          publicConfig: { theme: 'javascript:alert(1)' },
          configVersion: { increment: 1 },
        },
      });
      expect(await theme(sms)).toBeNull();
    });
  });
});
