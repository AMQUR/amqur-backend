import { OpenConversationService } from './open-conversation.service';
import type { LlmGenerateParams } from '../../ai/llm.provider';

function make(opts: {
  available?: boolean;
  enabled?: string;
  replies?: Array<{
    text: string;
    stopReason?: string;
    toolsUsed?: string[];
  } | null>;
}) {
  const calls: LlmGenerateParams[] = [];
  const replies = [...(opts.replies ?? [])];
  const router = {
    isAvailable: () => opts.available !== false,
    route: jest.fn(async (p: LlmGenerateParams) => {
      calls.push(p);
      const r = replies.shift();
      if (r === null || r === undefined)
        return { ok: false, reason: 'provider_error', attempts: 1 };
      p.onTextDelta?.(r.text);
      return {
        ok: true,
        attempts: 1,
        result: {
          text: r.text,
          provider: 'anthropic',
          model: p.model ?? 'm',
          latencyMs: 1,
          stopReason: r.stopReason,
          toolsUsed: r.toolsUsed,
        },
      };
    }),
  };
  const prisma = {
    tenant: {
      findUnique: jest.fn(async () => ({
        name: 'Dial Chevy',
        dealerGroupId: 'g1',
      })),
      findMany: jest.fn(async () => [
        {
          id: 't2',
          name: 'Dial Nissan',
          locations: [{ name: 'Dial Nissan of Chicago', address: null }],
        },
        { id: 'gsite', name: 'Group site', locations: [] },
      ]),
    },
    location: {
      findFirst: jest.fn(async () => ({
        name: 'Dial Chevy of Chicago',
        address: '1 Example Ave',
        phone: '555-0100',
        timezone: 'America/Chicago',
      })),
    },
    dealerGroup: {
      findUnique: jest.fn(async () => ({
        id: 'g1',
        name: 'Dial Auto Group',
        groupSiteTenantId: 'gsite',
      })),
    },
  };
  const metrics = { increment: jest.fn() };
  const config = {
    get: (k: string) =>
      k === 'OPEN_CONVERSATION_ENABLED' ? opts.enabled : undefined,
  };
  const svc = new OpenConversationService(
    router as never,
    prisma as never,
    metrics as never,
    config as never,
  );
  return { svc, calls, router };
}

const base = {
  tenantId: 't1',
  locationId: 'l1',
  conversationId: 'c1',
  assistantName: 'Dial Assistant',
  memory: ['shopping for: SUV, black, under $45,000'],
  knowledge: [],
  hoursSummary: null,
};

describe('OpenConversationService', () => {
  it('is off without a model or when the kill switch is set', () => {
    expect(make({ available: false }).svc.isEnabled()).toBe(false);
    expect(make({ enabled: 'false' }).svc.isEnabled()).toBe(false);
    expect(make({}).svc.isEnabled()).toBe(true);
  });

  it('sends the whole transcript, verified identity and tools; streams the reply', async () => {
    const { svc, calls } = make({ replies: [{ text: 'Islamabad.' }] });
    const deltas: string[] = [];
    const res = await svc.answer({
      ...base,
      transcript: [
        { role: 'USER', content: 'I am looking for a black SUV.' },
        { role: 'ASSISTANT', content: 'Sure.' },
        { role: 'USER', content: 'What is the capital of Pakistan?' },
      ],
      onTextDelta: (d) => deltas.push(d),
    });
    expect(res).toMatchObject({
      ok: true,
      text: 'Islamabad.',
      repaired: false,
    });
    expect(deltas.join('')).toBe('Islamabad.');
    const p = calls[0];
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(p.messages[0].content).toContain('black SUV');
    expect(p.messages[2].content).toBe('What is the capital of Pakistan?');
    // Verified store facts ride in the system channel, which the PII redactor leaves alone.
    const last = p.system ?? '';
    expect(last).toContain('555-0100');
    expect(last).toContain('Dial Chevy of Chicago');
    expect(last).toContain('Dial Auto Group');
    expect(last).toContain('Dial Nissan of Chicago');
    expect(last).not.toContain('Group site');
    expect(last).toContain('Hours: not verified');
    expect(last).toContain('shopping for: SUV, black, under $45,000');
    expect(p.redactRoles).toBe('user');
    expect(p.localTools?.map((t) => t.name)).toEqual([
      'calculate',
      'loan_payment',
    ]);
    expect(p.system).toContain('built by AMQUR');
    expect(p.system).not.toMatch(/sk-|password\s*[:=]/i);
  });

  it('local tools compute deterministically', () => {
    const { svc } = make({});
    const tools = (
      svc as unknown as {
        tools(): Array<{
          name: string;
          run(i: Record<string, unknown>): string;
        }>;
      }
    ).tools();
    expect(
      JSON.parse(tools[0].run({ expression: '17% of $42,500' })).result,
    ).toBe('7225');
    expect(
      JSON.parse(
        tools[1].run({ price: 40000, annualRatePercent: 6, termMonths: 60 }),
      ).monthlyPayment,
    ).toBeCloseTo(773.31, 2);
    expect(() => tools[0].run({ expression: 'process.exit()' })).toThrow();
  });

  it('repairs a reply that claims an action, without streaming the retry', async () => {
    const { svc, calls } = make({
      replies: [
        { text: "I've booked your test drive for Saturday." },
        {
          text: 'I can’t book from here — say "book a test drive" and the scheduler will take the request.',
        },
      ],
    });
    const res = await svc.answer({
      ...base,
      transcript: [{ role: 'USER', content: 'book it' }],
      onTextDelta: () => undefined,
    });
    expect(res).toMatchObject({ ok: true, repaired: true });
    expect(calls[1].onTextDelta).toBeUndefined();
    expect(calls[1].messages.at(-1)?.content).toContain('system_check');
  });

  it('never streams a sentence that fails the guard, and retracts what was shown', async () => {
    const { svc, router } = make({});
    router.route.mockImplementationOnce((async (p: LlmGenerateParams) => {
      for (const d of [
        'Sure thing. ',
        "I've booked your ",
        'test drive for Saturday. ',
        'See you then!',
      ])
        p.onTextDelta?.(d);
      return {
        ok: true,
        attempts: 1,
        result: {
          text: "Sure thing. I've booked your test drive for Saturday. See you then!",
          provider: 'anthropic',
          model: 'm',
          latencyMs: 1,
        },
      };
    }) as never);
    router.route.mockImplementationOnce((async () => ({
      ok: true,
      attempts: 1,
      result: {
        text: 'I can’t book from here.',
        provider: 'anthropic',
        model: 'm',
        latencyMs: 1,
      },
    })) as never);
    const events: Array<[string, boolean | undefined]> = [];
    const res = await svc.answer({
      ...base,
      transcript: [{ role: 'USER', content: 'book it' }],
      onTextDelta: (d, reset) => events.push([d, reset]),
    });
    expect(res).toMatchObject({
      ok: true,
      repaired: true,
      text: 'I can’t book from here.',
    });
    expect(events).toEqual([
      ['Sure thing. ', undefined],
      ['', true],
    ]);
    expect(events.map((e) => e[0]).join('')).not.toMatch(/booked/);
  });

  it('holds text inside an open code fence and flushes the tail at the end', async () => {
    const { svc, router } = make({});
    const full = 'Here:\n```js\nconst a = 1. \nconst b = 2.\n```\nDone';
    router.route.mockImplementationOnce((async (p: LlmGenerateParams) => {
      for (const ch of full.match(/[\s\S]{1,7}/g) ?? []) p.onTextDelta?.(ch);
      return {
        ok: true,
        attempts: 1,
        result: { text: full, provider: 'a', model: 'm', latencyMs: 1 },
      };
    }) as never);
    const out: string[] = [];
    const res = await svc.answer({
      ...base,
      transcript: [{ role: 'USER', content: 'code' }],
      onTextDelta: (d) => out.push(d),
    });
    expect(res.ok).toBe(true);
    expect(out.join('')).toBe(full);
    // no chunk ends in the middle of the fenced block
    for (const c of out.slice(0, -1))
      expect((c.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it('fails closed when the repair also claims an action, on refusal, and on provider failure', async () => {
    const bad = { text: 'You are approved for financing.' };
    expect(
      await make({ replies: [bad, bad] }).svc.answer({
        ...base,
        transcript: [{ role: 'USER', content: 'x' }],
      }),
    ).toEqual({ ok: false, reason: 'guard_rejected' });
    expect(
      await make({ replies: [{ text: '', stopReason: 'refusal' }] }).svc.answer(
        {
          ...base,
          transcript: [{ role: 'USER', content: 'x' }],
        },
      ),
    ).toEqual({ ok: false, reason: 'refusal' });
    expect(
      await make({ replies: [null] }).svc.answer({
        ...base,
        transcript: [{ role: 'USER', content: 'x' }],
      }),
    ).toEqual({ ok: false, reason: 'provider_error' });
  });

  it('buildMessages keeps the newest turns, starts on a user turn and redacts card numbers', () => {
    const rows = [
      { role: 'ASSISTANT', content: 'Hello' },
      { role: 'USER', content: 'my ssn is 123-45-6789' },
      { role: 'USER', content: 'second' },
      { role: 'ASSISTANT', content: 'ok' },
      { role: 'USER', content: 'last' },
    ];
    const out = OpenConversationService.buildMessages(rows, '<context/>');
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(out[0].content).not.toContain('123-45-6789');
    expect(out[0].content).toContain('second');
    expect(out[2].content).toBe('last\n\n<context/>');
  });

  it('classifyLane parses one word and returns null on anything else', async () => {
    const run = async (text: string | null) =>
      make({ replies: [text === null ? null : { text }] }).svc.classifyLane({
        message: 'What is 17% of $42,500?',
        recent: [],
        pending: null,
        ruleIntents: ['PAYMENT_ESTIMATE'],
        tenantId: 't1',
      });
    expect(await run('CONVERSATION')).toBe('conversation');
    expect(await run('dealership.')).toBe('dealership');
    expect(await run('maybe')).toBeNull();
    expect(await run(null)).toBeNull();
  });
});
