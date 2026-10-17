import { DEFAULT_SOURCE_AUTHORITY } from '../source-authority/source-authority.service';
import { nextBestAction } from '../leads/next-best-action';
import { scoreJourney, LEAD_SCORE_VERSION } from '../leads/lead-scoring';

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
    // Ported to versioned journey scoring (set-based: repeats cannot inflate the score).
    const r = scoreJourney([
      'vehicle_selected',
      'payment_estimate',
      'appointment_requested',
      'payment_estimate',
    ]);
    expect(r.score).toBe(3 + 3 + 8);
    expect(r.reasons.map((x) => x.signal)).toContain('payment_estimate');
    expect(r.version).toBe(LEAD_SCORE_VERSION);
    expect(r.nextBestAction).toBeTruthy();
  });
});
