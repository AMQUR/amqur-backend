import { IntentDetector } from './intent.detector';
import { ChatIntent } from './intent.types';

describe('IntentDetector', () => {
  it('detects human handoff', () => {
    expect(IntentDetector.detect('I need a real person please')).toBe(
      ChatIntent.HUMAN_HANDOFF,
    );
    expect(IntentDetector.detect('talk to someone at the store')).toBe(
      ChatIntent.HUMAN_HANDOFF,
    );
  });

  it('detects inventory search', () => {
    expect(IntentDetector.detect('show me wranglers under 45000')).toBe(
      ChatIntent.INVENTORY_SEARCH,
    );
  });

  it('detects payment estimate', () => {
    expect(IntentDetector.detect('what would my monthly payment be')).toBe(
      ChatIntent.PAYMENT_ESTIMATE,
    );
  });

  it('detects parts inquiry', () => {
    expect(IntentDetector.detect('do you have a brake pad for my VIN')).toBe(
      ChatIntent.PARTS_INQUIRY,
    );
  });
});
