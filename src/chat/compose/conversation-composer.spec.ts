import { ConversationComposerService } from './conversation-composer.service';
import { validateComposedReply } from './reply-validator';

const draft =
  "For the 2025 Jeep Grand Cherokee Limited 4x4 at $49,870, you're looking at roughly $785 a month with $5,000 down over 72 months. That uses an example 7.9% rate and leaves out taxes and fees — an estimate, not a financing offer.";

describe('validateComposedReply', () => {
  const base = { draft, facts: [], customerText: ['what if I put 5k down'] };
  it('accepts a natural rewrite that answers first and keeps the caveat', () => {
    expect(
      validateComposedReply({
        ...base,
        reply:
          'With $5,000 down it comes to roughly $785 a month over 72 months — that’s an estimate at an example 7.9% rate, before taxes and fees.',
      }),
    ).toEqual({ ok: true });
  });
  it('accepts general knowledge and small talk with no numbers', () => {
    expect(
      validateComposedReply({
        draft: 'Hi there!',
        facts: [],
        customerText: ['what does AWD mean'],
        reply:
          'AWD sends power to all four wheels automatically, which helps a lot on wet or snowy Chicago roads.',
      }),
    ).toEqual({ ok: true });
  });
  it('rejects an invented number, a commitment word, a dropped estimate label', () => {
    const r1 = validateComposedReply({
      ...base,
      reply: 'It would be about $759 a month — an estimate.',
    });
    expect(r1.ok).toBe(false);
    const r2 = validateComposedReply({
      draft:
        "I've requested a visit for Friday at 5 PM. It's a request for now.",
      facts: [],
      customerText: [],
      reply: 'You’re confirmed for Friday at 5 PM.',
    });
    expect(r2.ok).toBe(false);
    const r3 = validateComposedReply({
      ...base,
      reply: 'That’s $785 a month with $5,000 down over 72 months.',
    });
    expect(r3.ok).toBe(false);
  });
  it('rejects a cut-off reply and an invented live score', () => {
    expect(
      validateComposedReply({ ...base, reply: 'With $5,000 down you would' })
        .ok,
    ).toBe(false);
    expect(
      validateComposedReply({
        draft: 'I can’t check live scores.',
        facts: [],
        customerText: ['did the bulls win'],
        reply: 'Yes! The Bulls won 112-104.',
      }).ok,
    ).toBe(false);
  });
  it('rejects walls of text and stacked questions', () => {
    const wall =
      'Thank you so much for reaching out today. I would be more than happy to help you find the perfect vehicle. We have many options across our inventory and financing team. Please share your budget and preferred time.';
    expect(validateComposedReply({ ...base, reply: wall }).ok).toBe(false);
    expect(
      validateComposedReply({
        draft: 'We have two matches.',
        facts: [],
        customerText: ['wrangler'],
        reply: 'We have two. What color? What budget?',
      }).ok,
    ).toBe(false);
  });
  it('lets the customer’s own numbers be repeated', () => {
    expect(
      validateComposedReply({
        draft: 'Here are 3 SUVs that fit.',
        facts: [],
        customerText: ['I have three kids and want something under 45000'],
        reply: 'Here are 3 SUVs under 45000 that fit three kids.',
      }).ok,
    ).toBe(true);
  });
});

describe('ConversationComposerService', () => {
  const metrics = { increment: jest.fn() };
  const input = {
    message: 'what if I put 5 grand down',
    transcript: [],
    memory: [],
    draft,
    facts: [],
    cards: [],
    language: 'en',
    assistantName: 'Dial Concierge',
    tenantId: 't1',
  };
  const router = (texts: string[]) => {
    let i = 0;
    return {
      isAvailable: () => true,
      route: jest.fn(async () => ({
        ok: true,
        attempts: 1,
        result: {
          text: texts[Math.min(i++, texts.length - 1)],
          provider: 'fake',
          model: 'm',
          latencyMs: 1,
        },
      })),
    };
  };
  it('returns a validated composed reply in one call', async () => {
    const r = router([
      'With $5,000 down it’s roughly $785 a month over 72 months — an estimate, not an offer.',
    ]);
    const c = new ConversationComposerService(r as never, metrics as never);
    const out = await c.compose(input);
    expect(out.status).toBe('composed');
    expect(r.route).toHaveBeenCalledTimes(1);
  });
  it('repairs once after a rejected attempt', async () => {
    const r = router([
      'About $700 a month.',
      'Roughly $785 a month with $5,000 down over 72 months — an estimate.',
    ]);
    const c = new ConversationComposerService(r as never, metrics as never);
    const out = await c.compose(input);
    expect(out.status).toBe('repaired');
    expect(r.route).toHaveBeenCalledTimes(2);
  });
  it('falls back to the server draft after two rejections (bounded calls)', async () => {
    const r = router(['About $700 a month.']);
    const c = new ConversationComposerService(r as never, metrics as never);
    const out = await c.compose(input);
    expect(out.status).toBe('fallback');
    expect(r.route).toHaveBeenCalledTimes(2);
  });
  it('never sends phone numbers or SSNs in the transcript', async () => {
    const r = router(['Sure.']);
    const c = new ConversationComposerService(r as never, metrics as never);
    await c.compose({
      ...input,
      transcript: [{ role: 'USER', content: 'my ssn is 123-45-6789' }],
    });
    const sent = JSON.stringify(r.route.mock.calls[0]);
    expect(sent).not.toContain('123-45-6789');
  });
});
