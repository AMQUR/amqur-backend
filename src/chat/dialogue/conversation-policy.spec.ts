import {
  acceptCustomerReply,
  chooseReplyWithinBudget,
  countQuestions,
  estimateWords,
  evaluateLength,
  planConciseResponse,
  resolveVerbosityMode,
  splitSentences,
  trimToSentenceBudget,
} from './conversation-policy';
import { decideRapport, DEFAULT_RAPPORT_CONFIG } from './contextual-rapport';

describe('conversation-policy length helpers', () => {
  it('counts words without inflating URLs and VINs', () => {
    const t =
      'See https://example.com/cars and VIN 1C4HJXDG5JW123456 for $42,995 at 0% APR.';
    expect(estimateWords(t)).toBeLessThan(20);
  });

  it('splits sentences without breaking decimals or U.S.', () => {
    const s = splitSentences(
      'The U.S. MSRP is $42,995. Want the full breakdown?',
    );
    expect(s).toHaveLength(2);
  });

  it('counts at most one question mark cluster correctly', () => {
    expect(countQuestions('Want to see both?')).toBe(1);
    expect(countQuestions('Name? Phone? Email?')).toBe(3);
  });
});

describe('planConciseResponse', () => {
  it('keeps one answer and one question for inventory with cards', () => {
    const planned = planConciseResponse(
      {
        acknowledgement: undefined,
        directAnswer: [
          'Yes, we have two that match your budget.',
          'One is a black Wrangler Sport.',
          'The other is a gray Sahara.',
        ],
        actionNarration: ['I pulled them from live inventory.'],
        followUpQuestion: 'Want to see the details on both?',
      },
      {
        customerMessage: 'Do you have a black Wrangler under $45k?',
        hasCards: true,
        intents: ['SEARCH_INVENTORY'],
      },
    );
    expect(planned.verbosityMode).toBe('concise');
    expect(planned.plan.directAnswer?.length).toBe(1);
    expect(planned.plan.actionNarration).toBeUndefined();
    expect(planned.plan.followUpQuestion).toMatch(/Want to see/);
    expect(planned.droppedAnswers).toBe(2);
  });

  it('allows detailed mode when the customer asks for all features', () => {
    expect(
      resolveVerbosityMode({
        customerMessage: 'Tell me all the features on this one',
      }),
    ).toBe('detailed');
  });

  it('drops sales questions on complaints', () => {
    const planned = planConciseResponse(
      {
        directAnswer: ["I'm sorry you've had to chase this."],
        followUpQuestion: 'What is your phone number?',
      },
      {
        customerMessage: 'This is ridiculous, I want a manager',
        turnKind: 'complaint',
        intents: ['HUMAN_HANDOFF'],
      },
    );
    expect(planned.plan.followUpQuestion).toBeUndefined();
  });
});

describe('acceptCustomerReply / chooseReplyWithinBudget', () => {
  it('rejects multi-question composed replies', () => {
    const r = acceptCustomerReply(
      'We have two Wranglers. What is your budget? What color do you want?',
      'concise',
    );
    expect(r.accept).toBe(false);
    expect(r.reason).toBe('multiple_questions');
  });

  it('falls back to a trimmed draft instead of mid-sentence truncation', () => {
    const longDraft =
      'Yes, we have two that match. One is black and one is gray. I can also check trade-ins and financing programs if you want. Want to see both?';
    const out = chooseReplyWithinBudget({
      composed:
        'Absolutely! I would be more than happy to walk you through every single option we have on the lot today including financing, trade, and service specials while also asking for your phone, email, and ZIP. What works?',
      draft: longDraft,
      mode: 'concise',
    });
    expect(out.source).toBe('draft');
    expect(out.text.endsWith('?') || /Want to see/.test(out.text)).toBe(true);
    expect(out.text.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(3);
    // Must not end mid-word from a hard char cut
    expect(out.text).toMatch(/[.!?]$/);
  });

  it('accepts a short natural price answer', () => {
    const reply =
      '$42,995 is the current listed price for stock ABC123. Want me to send the full breakdown?';
    const r = acceptCustomerReply(reply, 'concise');
    expect(r.accept).toBe(true);
    expect(r.length.sentences).toBeLessThanOrEqual(2);
    expect(r.length.questions).toBe(1);
  });

  it('trimToSentenceBudget keeps complete sentences', () => {
    const t = trimToSentenceBudget(
      'First sentence here. Second sentence here. Third sentence should often drop. Want a visit?',
      'concise',
    );
    expect(t).toMatch(/[.!?]$/);
    expect(splitSentences(t).length).toBeLessThanOrEqual(2);
  });

  it('trimToSentenceBudget keeps estimate caveats', () => {
    const t = trimToSentenceBudget(
      'Roughly $785 a month with $5,000 down over 72 months. That is an estimate at an example 7.9% rate, before taxes and fees. Want to adjust the term?',
      'concise',
    );
    expect(t).toMatch(/estimate/i);
    expect(t).toMatch(/\?$/);
  });
});

describe('evaluateLength gates', () => {
  it('flags walls of text on concise mode', () => {
    const wall =
      'Thank you so much for reaching out to our dealership today. I would be more than happy to assist you with finding the perfect vehicle for your needs. We have a wide selection of cars, trucks, and SUVs. Please let me know your budget, preferred color, trade-in details, and the best time to call you.';
    const e = evaluateLength(wall, 'concise');
    expect(e.withinBudget).toBe(false);
    expect(e.warnings.length).toBeGreaterThan(0);
  });
});

describe('contextual rapport (fail-closed)', () => {
  it('never injects when disabled', () => {
    const d = decideRapport({
      config: DEFAULT_RAPPORT_CONFIG,
      customerMessage: 'Good morning!',
      isTaskTurn: false,
      priorRapportCount: 0,
    });
    expect(d.inject).toBe(false);
  });

  it('never injects weather facts without verified data', () => {
    const d = decideRapport({
      config: { ...DEFAULT_RAPPORT_CONFIG, enabled: true, allowWeather: true },
      customerMessage: 'Rainy day over there?',
      isTaskTurn: false,
      priorRapportCount: 0,
    });
    expect(d.inject).toBe(false);
    expect(d.reason).toMatch(/weather_unavailable/);
  });

  it('skips rapport on price questions', () => {
    const d = decideRapport({
      config: { ...DEFAULT_RAPPORT_CONFIG, enabled: true, allowDaypart: true },
      customerMessage: 'How much is this one?',
      isTaskTurn: true,
      priorRapportCount: 0,
    });
    expect(d.inject).toBe(false);
    expect(d.reason).toBe('task_turn');
  });

  it('allows a daypart opener on a pure greeting when enabled', () => {
    const d = decideRapport({
      config: { ...DEFAULT_RAPPORT_CONFIG, enabled: true },
      customerMessage: 'Good morning!',
      isTaskTurn: false,
      priorRapportCount: 0,
      storeTimezone: 'America/Chicago',
      now: new Date('2026-10-16T14:00:00Z'),
    });
    expect(d.inject).toBe(true);
    expect(d.opener).toMatch(/Good (morning|afternoon|evening)!/);
  });
});
