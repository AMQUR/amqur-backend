import { normalizeCustomerText as n } from './normalize';
import { understandTurn } from './turn-understanding';

describe('customer text normalization', () => {
  it('expands texting slang', () => {
    expect(n('are u a bot')).toBe('are you a bot');
    expect(n('whats ur best price pls')).toBe('whats your best price please');
    expect(n('pmt on that?')).toBe('payment on that?');
  });
  it('fixes keyword typos but never real inflections', () => {
    expect(n('whats the paymnet')).toBe('whats the payment');
    expect(n('can i shedule service')).toBe('can i schedule service');
    expect(n('approve me')).toBe('approve me');
    expect(n('scheduled for friday')).toBe('scheduled for friday');
    expect(n('compass')).toBe('compass');
  });
  it('joins voice-transcription splits of model names', () => {
    expect(n("i'm interested in rang ler")).toBe("i'm interested in wrangler");
    expect(n('show me a grand wagon ear')).toBe('show me a grand wagoneer');
  });
  it('lets understanding route noisy text correctly', () => {
    const u = (m: string) =>
      understandTurn(m, {
        timeZone: 'America/Chicago',
        hasSelectedVehicle: true,
      });
    expect(u('whats the paymnet on that').primary).toBe('PAYMENT_ESTIMATE');
    expect(u('Are u a bot?').primary).toBe('SMALL_TALK');
    expect(u('my brakes are squeaking, can you look at it').primary).toBe(
      'SERVICE_APPOINTMENT',
    );
    expect(u('need a tire rotation').primary).toBe('SERVICE_APPOINTMENT');
    expect(u('how do I get financed').primary).toBe('CREDIT_APPLICATION');
    expect(u('What would the total be with taxes and fees?').primary).toBe(
      'OTD_QUOTE',
    );
    expect(u('connect me with a salesperson').primary).toBe('HUMAN_HANDOFF');
    expect(u('¿Tienen Compass?').entities.language).toBe('es');
  });
});
