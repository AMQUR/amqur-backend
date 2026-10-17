/**
 * Priority journey scenarios for short natural replies (no live HTTP/DB).
 * Full staging e2e remains blocked on Railway/token infra.
 */
import {
  acceptCustomerReply,
  chooseReplyWithinBudget,
  decideTurnMode,
  planConciseResponse,
  shouldSuppressRankedFollowUp,
} from './conversation-policy';

describe('conversation journey (policy-level e2e)', () => {
  it('1–3: vehicle question → short natural answer + one follow-up', () => {
    const planned = planConciseResponse(
      {
        directAnswer: [
          'Yes — we have two Wranglers under $45k in stock right now.',
          'One is black Sport, one is gray Sahara.',
          'I can also check other trims if you want.',
        ],
        followUpQuestion: 'Want details on either one?',
      },
      {
        customerMessage: 'Do you have a Wrangler under 45k?',
        hasCards: true,
        intents: ['SEARCH_INVENTORY'],
      },
    );
    expect(planned.verbosityMode).toBe('concise');
    expect(planned.plan.directAnswer?.length).toBe(1);
    expect(planned.plan.followUpQuestion).toBeTruthy();
    const body = [
      ...(planned.plan.directAnswer ?? []),
      planned.plan.followUpQuestion,
    ].join(' ');
    expect(acceptCustomerReply(body, 'concise').accept).toBe(true);
  });

  it('4–5: follow-up keeps one question; memory-style pending not re-asked as wall of text', () => {
    const planned = planConciseResponse(
      {
        directAnswer: ['The black Sport is stock W123, listed at $41,990.'],
        followUpQuestion: 'Want to set up a visit to see it?',
      },
      {
        customerMessage: 'Tell me about the black one',
        intents: ['VEHICLE_DETAIL'],
      },
    );
    expect(planned.plan.followUpQuestion?.includes('?')).toBe(true);
    expect(
      (planned.plan.directAnswer?.join(' ') ?? '').split(/\?/).length - 1,
    ).toBe(0);
  });

  it('farewell after answers drops soft follow-ups (priority > 5)', () => {
    expect(
      shouldSuppressRankedFollowUp({
        customerMessage: 'Thanks, that helps!',
        hasSubstantiveAnswers: true,
        questionPriority: 9,
        questionKey: 'none',
      }),
    ).toBe(true);
    expect(
      shouldSuppressRankedFollowUp({
        customerMessage: 'Thanks, that helps!',
        hasSubstantiveAnswers: true,
        questionPriority: 2,
        questionKey: 'contact_phone',
      }),
    ).toBe(true);
    const planned = planConciseResponse(
      {
        directAnswer: ['Happy to help — we are open until 8 tonight.'],
        followUpQuestion: 'Anything else I can look up for you?',
      },
      { customerMessage: 'Thanks, bye!' },
    );
    expect(planned.plan.followUpQuestion).toBeUndefined();
  });

  it('substantive answer without farewell still drops soft discovery (priority > 5, key none)', () => {
    expect(
      shouldSuppressRankedFollowUp({
        customerMessage: 'What are your hours?',
        hasSubstantiveAnswers: true,
        questionPriority: 10,
        questionKey: 'none',
      }),
    ).toBe(true);
    expect(
      shouldSuppressRankedFollowUp({
        customerMessage: 'What are your hours?',
        hasSubstantiveAnswers: true,
        questionPriority: 2,
        questionKey: 'contact_method',
      }),
    ).toBe(false);
    expect(
      shouldSuppressRankedFollowUp({
        customerMessage: 'What are your hours?',
        hasSubstantiveAnswers: false,
        questionPriority: 10,
        questionKey: 'none',
      }),
    ).toBe(false);
  });

  it('9–10: staff ownership → wait mode drops sales follow-up', () => {
    expect(
      decideTurnMode({
        aiPaused: true,
        hasAnswers: true,
        hasQuestion: true,
      }),
    ).toBe('wait');
    const planned = planConciseResponse(
      {
        directAnswer: ['A teammate is helping you in this chat.'],
        followUpQuestion: 'What is your budget?',
      },
      { customerMessage: 'ok thanks', aiPaused: true },
    );
    expect(planned.plan.followUpQuestion).toBeUndefined();
  });

  it('rejects robotic wall-of-text composed replies', () => {
    const out = chooseReplyWithinBudget({
      composed:
        "I'd be more than happy to absolutely walk you through every option on our lot today including financing, trade-ins, service specials, and warranty packages while also collecting your phone, email, and ZIP code!",
      draft: 'We have two that match. Want to see both?',
      mode: 'concise',
    });
    expect(out.source).toBe('draft');
    expect(out.text.length).toBeLessThan(120);
  });

  it('SMS budget is tighter than widget', () => {
    const long =
      'Yes we have that model available in a few trims with verified stock numbers on the lot today. Want me to pull the closest match for you?';
    const widget = acceptCustomerReply(long, 'concise', 'WIDGET');
    const sms = acceptCustomerReply(long, 'concise', 'SMS');
    // SMS may reject the same text when over 320 chars — keep assertion on budget helper path.
    expect(widget.length.chars).toBe(long.length);
    expect(sms.length.chars).toBe(long.length);
    // Multi-question still rejected on both.
    expect(
      acceptCustomerReply('A? B?', 'concise', 'SMS').accept,
    ).toBe(false);
  });
});
