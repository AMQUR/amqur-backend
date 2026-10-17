/**
 * Acceptance scenarios from the master prompt — policy-level shapes.
 * Full tool-backed e2e remains in ai-eval / conversation-style suites.
 */
import {
  acceptCustomerReply,
  countQuestions,
  planConciseResponse,
  resolveVerbosityMode,
  splitSentences,
} from './conversation-policy';
import { decideRapport, DEFAULT_RAPPORT_CONFIG } from './contextual-rapport';

function assertShort(reply: string) {
  expect(acceptCustomerReply(reply, 'concise').accept).toBe(true);
  expect(splitSentences(reply).length).toBeLessThanOrEqual(2);
  expect(countQuestions(reply)).toBeLessThanOrEqual(1);
}

describe('short-reply acceptance scenarios', () => {
  it('1 greeting is one friendly sentence', () => {
    assertShort('Good morning! What can I help you with?');
  });

  it('2 inventory match stays short with one question', () => {
    const p = planConciseResponse(
      {
        directAnswer: [
          'Yes, we have two that match your budget.',
          'Extra detail that should drop when cards show.',
        ],
        followUpQuestion: 'Want to see the details on both?',
      },
      { customerMessage: 'black Wrangler under 45k', hasCards: true },
    );
    expect(p.plan.directAnswer).toHaveLength(1);
    expect(countQuestions(p.plan.followUpQuestion ?? '')).toBe(1);
  });

  it('3 price answer shape', () => {
    assertShort(
      '$42,995 is the current listed price for stock ABC123. Want me to send the full breakdown?',
    );
  });

  it('4 APR without program does not invent', () => {
    assertShort(
      "I can't confirm a 0% offer on this vehicle right now. Want me to check current financing programs with our team?",
    );
  });

  it('5 trade asks one progressive question', () => {
    const p = planConciseResponse(
      {
        directAnswer: ['Yes, we can help you explore a trade-in.'],
        followUpQuestion: 'What year, make, and model is yours?',
      },
      { customerMessage: 'Can I trade my car?', turnKind: 'trade' },
    );
    expect(p.plan.followUpQuestion).toMatch(/year/i);
    expect(countQuestions(p.plan.followUpQuestion ?? '')).toBe(1);
  });

  it('6 appointment preference is not a confirmation', () => {
    const reply = 'Tuesday could work. What time would you prefer?';
    assertShort(reply);
    expect(reply).not.toMatch(/\b(confirmed|booked)\b/i);
  });

  it('7 unverified service price stays honest', () => {
    assertShort(
      "I don't have a verified price for that service yet. Want me to have the service team check it?",
    );
  });

  it('8 no weather without verified data', () => {
    const d = decideRapport({
      config: { ...DEFAULT_RAPPORT_CONFIG, enabled: true, allowWeather: true },
      customerMessage: 'Rainy day over there?',
      isTaskTurn: false,
      priorRapportCount: 0,
    });
    expect(d.inject).toBe(false);
    expect(d.reason).toMatch(/weather_unavailable/);
  });

  it('9 sports unavailable → no fake score', () => {
    const d = decideRapport({
      config: { ...DEFAULT_RAPPORT_CONFIG, enabled: true, allowSports: true },
      customerMessage: 'Did the Bears win?',
      isTaskTurn: false,
      priorRapportCount: 0,
    });
    expect(d.inject).toBe(false);
  });

  it('12 detailed ask switches mode', () => {
    expect(
      resolveVerbosityMode({
        customerMessage: 'Tell me all the features on this Jeep',
      }),
    ).toBe('detailed');
  });

  it('13 complaint drops sales questions', () => {
    const p = planConciseResponse(
      {
        directAnswer: ["I'm sorry you've had to chase this."],
        followUpQuestion: 'Want to schedule a test drive?',
      },
      {
        customerMessage: 'This is ridiculous',
        turnKind: 'complaint',
        intents: ['HUMAN_HANDOFF'],
      },
    );
    expect(p.plan.followUpQuestion).toBeUndefined();
  });

  it('14 stacked questions rejected', () => {
    expect(
      acceptCustomerReply(
        'What is your phone? What is your email? What is your ZIP?',
        'concise',
      ).accept,
    ).toBe(false);
  });

  it('15 in-stock answer is short', () => {
    assertShort('Yes — that Wrangler is still showing as available. Want the details?');
  });
});
