import { understandTurn } from './turn-understanding';
import {
  isWeakUnderstanding,
  mergeInterpretation,
  parseInterpretation,
} from './model-interpretation';

const u = (m: string) =>
  understandTurn(m, { timeZone: 'America/Chicago', hasSelectedVehicle: true });

describe('model-assisted understanding', () => {
  it('parses a valid proposal and drops unknown/forbidden intents and junk entities', () => {
    const m = parseInterpretation(
      'Sure! {"goal":"buy the jeep","intents":[{"intent":"PURCHASE_START","confidence":0.92},{"intent":"APPOINTMENT_CANCEL","confidence":0.99},{"intent":"DROP_TABLE","confidence":1}],"entities":{"zip":"6062","downPayment":-5,"model":"Grand Cherokee","paymentMethod":"cash","price":1}}',
    );
    expect(m?.intents).toEqual([
      { intent: 'PURCHASE_START', confidence: 0.92 },
    ]);
    expect(m?.entities).toEqual({
      model: 'Grand Cherokee',
      paymentMethod: 'cash',
    });
  });

  it('rejects malformed output', () => {
    expect(parseInterpretation('no json here')).toBeNull();
    expect(parseInterpretation('{"intents":"PURCHASE_START"}')).toBeNull();
    expect(
      parseInterpretation('{"intents":[{"intent":"UNKNOWN"}]}'),
    ).toBeNull();
  });

  it('is consulted only when the rules found nothing specific', () => {
    expect(
      isWeakUnderstanding(u('hmm so like what would you do in my shoes')),
    ).toBe(true);
    expect(isWeakUnderstanding(u('How to buy it now?'))).toBe(false);
  });

  it('merges model intents below deterministic ones, never above', () => {
    const base = u('hmm so like what would you do in my shoes');
    const merged = mergeInterpretation(
      base,
      {
        goal: 'advice',
        intents: [
          { intent: 'PURCHASE_START', confidence: 0.95 },
          { intent: 'OTD_QUOTE', confidence: 0.5 },
        ],
        entities: {},
      },
      'hmm so like what would you do in my shoes',
    );
    expect(merged.intents.map((i) => i.intent)).toEqual(['PURCHASE_START']);
    expect(merged.intents[0].confidence).toBe(0.85);
    expect(merged.intents[0].evidence).toBe('model');
  });

  it('never accepts a ZIP or down payment the customer did not actually type', () => {
    const base = u('whatever works for my area');
    const merged = mergeInterpretation(
      base,
      {
        goal: 'otd',
        intents: [{ intent: 'OTD_QUOTE', confidence: 0.9 }],
        entities: { zip: '60629', downPayment: 5000 },
      },
      'whatever works for my area',
    );
    expect(merged.entities.zip).toBeUndefined();
    expect(merged.entities.downPayment).toBeUndefined();
  });
});
