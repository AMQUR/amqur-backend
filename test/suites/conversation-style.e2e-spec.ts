import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';

/**
 * Style regression over full transcripts (deterministic path; LLM disabled in test env).
 * Depends on the journey-motors fixture seeded by journeys.e2e-spec (runInBand order: j < c is
 * NOT guaranteed, so this suite seeds nothing and skips if the fixture tenant is absent).
 */
const BANNED = [
  /^(absolutely|great question|certainly)\b/i,
  /i'?d be happy to help/i,
  /\b(moves quick|won'?t last|act fast|others are looking|someone else is interested|selling fast)\b/i,
  /\bi'?m (?:a )?human\b/i,
  /\bguarantee(?:d)? approval\b/i,
  /\byou(?:'re| are) approved\b/i,
  /\byour rate is\b/i,
];

const SCRIPTS: string[][] = [
  [
    'Looking for a black Wrangler under 45 grand.',
    'Which of those has heated seats?',
    'What would the payment be with 5k down?',
    "I've got a 2021 Accord with 48k miles.",
    'I can come Saturday at 3.',
    'Send me the credit application.',
    'Sam Rivera',
    'sam.rivera@example.com',
  ],
  [
    'I need an oil change Friday morning.',
    'Actually make it Saturday.',
    'Do you have a shuttle?',
  ],
  [
    'I need front brakes for my 2021 Grand Cherokee. How much?',
    '1C4RJFBG5MC123456',
    'Yes, can you install them Saturday morning?',
  ],
  ["I'm pissed. I've called twice and nobody is helping me.", '312-555-0142'],
  [
    'hi',
    'what time do you close?',
    'Do you have any Grand Cherokees?',
    'is it still available?',
  ],
  ['Hola, busco una Wrangler negra', '¿Tienen horario el sábado?'],
];

describe('conversation style regression', () => {
  let ctx: E2eCtx;
  let tok: string | null = null;

  beforeAll(async () => {
    ctx = await createE2eApp();
    const r = await request(ctx.app.getHttpServer())
      .post('/api/public/widget-token')
      .set('Origin', 'http://127.0.0.1:18084')
      .send({ tenantSlug: 'journey-motors', locationSlug: 'main' });
    tok = r.status < 300 ? unwrap<{ token: string }>(r.body).token : null;
  });
  afterAll(async () => ctx.app.close());

  it.each(SCRIPTS.map((s, i) => [i, s] as const))(
    'script %i',
    async (_i, lines) => {
      if (!tok) return; // fixture not seeded in this run
      let id: string | undefined;
      let prev = '';
      for (const m of lines) {
        const r = await request(ctx.app.getHttpServer())
          .post('/api/chat')
          .set('Authorization', `Bearer ${tok}`)
          .send({ message: m, conversationId: id });
        const d = unwrap<{
          reply: string;
          conversationId: string;
          cards: Array<{ kind: string }>;
        }>(r.body);
        id = d.conversationId;
        const reply = d.reply;
        expect(reply.length).toBeGreaterThan(0);
        expect(reply.length).toBeLessThan(700);
        for (const b of BANNED) expect(reply).not.toMatch(b);
        // one question at a time
        expect((reply.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
        // never repeat the previous reply verbatim
        expect(reply).not.toBe(prev);
        // appointment replies always carry request semantics unless provider-confirmed
        if (d.cards.some((c) => c.kind === 'appointment'))
          expect(reply.toLowerCase()).toMatch(/request|solicitud/);
        prev = reply;
      }
    },
  );
});
