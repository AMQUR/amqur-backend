import {
  blocksConsequentialAffirm,
  isExplicitConsequentialConsent,
  isTypoAcknowledgment,
} from './affirmative-consent';

describe('affirmative consent gating', () => {
  it.each(['oAY', 'OKy', 'oky', 'oay', 'okey', 'OAY!'])(
    '"%s" is a typo acknowledgment',
    (m) => {
      expect(isTypoAcknowledgment(m)).toBe(true);
    },
  );

  it.each(['ok', 'okay', 'yes', 'sure', 'yes please'])(
    '"%s" is not a typo acknowledgment',
    (m) => {
      expect(isTypoAcknowledgment(m)).toBe(false);
    },
  );

  it.each([
    'yes',
    'yes please',
    'I agree',
    'I consent',
    'please do',
    'go ahead',
  ])('"%s" is explicit consequential consent', (m) => {
    expect(isExplicitConsequentialConsent(m)).toBe(true);
  });

  it.each(['oAY', 'OKy', 'ok', 'okay', 'sure', 'okie'])(
    '"%s" is NOT explicit consequential consent',
    (m) => {
      expect(isExplicitConsequentialConsent(m)).toBe(false);
    },
  );

  it('blocks typo ack from authorizing SMS consent', () => {
    expect(blocksConsequentialAffirm('oAY', 'text_consent')).toBe(true);
    expect(blocksConsequentialAffirm('OKy', 'text_consent')).toBe(true);
    expect(blocksConsequentialAffirm('ok', 'text_consent')).toBe(true);
    expect(blocksConsequentialAffirm('yes', 'text_consent')).toBe(false);
  });

  it('blocks typo/bare-ok from credit and handoff offers', () => {
    expect(blocksConsequentialAffirm('oay', 'none', 'credit')).toBe(true);
    expect(blocksConsequentialAffirm('okay', null, 'handoff')).toBe(true);
    expect(blocksConsequentialAffirm('yes please', null, 'credit')).toBe(false);
  });

  it('does not block conversational continuity offers', () => {
    expect(blocksConsequentialAffirm('oAY', 'none', 'payment')).toBe(false);
    expect(blocksConsequentialAffirm('OKy', 'none', 'show_vehicles')).toBe(
      false,
    );
    expect(blocksConsequentialAffirm('oky', 'appointment_date')).toBe(false);
  });
});
