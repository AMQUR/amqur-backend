import { factsPreserved } from './facts-preserved';

const draft =
  "For the 2025 Jeep Grand Cherokee at $49,870, you're looking at roughly $785 a month with $5,000 down over 72 months. That uses an example 7.9% rate — an estimate, not a financing offer.";

describe('factsPreserved', () => {
  it('accepts a rewording that keeps every number and limiting word', () => {
    expect(
      factsPreserved(
        draft,
        "With $5,000 down on the 2025 Grand Cherokee ($49,870), it'd be about $785 a month over 72 months — using an example 7.9% rate, so it's an estimate, not a financing offer.",
      ),
    ).toBe(true);
  });
  it('rejects a changed, added or dropped number', () => {
    expect(factsPreserved(draft, draft.replace('$785', '$759'))).toBe(false);
    expect(factsPreserved(draft, `${draft} Only 2 left!`)).toBe(false);
    expect(factsPreserved(draft, draft.replace(' over 72 months', ''))).toBe(
      false,
    );
  });
  it('rejects dropping "estimate" or "request"', () => {
    expect(factsPreserved(draft, draft.replace('an estimate, ', ''))).toBe(
      false,
    );
    expect(
      factsPreserved(
        "I've requested a visit for Friday at 5 PM — a request, not confirmed.",
        "You're booked for Friday at 5 PM!",
      ),
    ).toBe(false);
  });
});
