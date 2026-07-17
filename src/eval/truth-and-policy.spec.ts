import { DEFAULT_SOURCE_AUTHORITY } from '../source-authority/source-authority.service';
import { nextBestAction } from '../leads/next-best-action';
import { scoreLeadWithReasons } from '../chat/lead-intelligence';

describe('source authority defaults', () => {
  it('keeps advertised_price on vauto', () => {
    const rule = DEFAULT_SOURCE_AUTHORITY.find(
      (r) => r.field === 'advertised_price',
    );
    expect(rule?.primarySource).toBe('vauto');
  });

  it('keeps service appointment status on tekion', () => {
    const rule = DEFAULT_SOURCE_AUTHORITY.find(
      (r) => r.field === 'service_appointment_status',
    );
    expect(rule?.primarySource).toBe('tekion');
    expect(rule?.fallbackSource).toBeUndefined();
  });
});

describe('nextBestAction', () => {
  it('asks for contact when missing', () => {
    expect(
      nextBestAction({
        score: 10,
        interestedVin: '1C4RJFBG0JC123456',
        email: null,
        phone: null,
        financingNeeded: false,
        stage: 'WARM',
      }),
    ).toBe('request_contact_info');
  });
});

describe('lead scoring reasons', () => {
  it('records observable reason codes', () => {
    const r = scoreLeadWithReasons(0, [
      'vehicle_view',
      'payment',
      'appointment',
    ]);
    expect(r.score).toBeGreaterThan(0);
    expect(r.reasons).toContain('payment');
    expect(r.version).toBe('rules-v2');
  });
});
