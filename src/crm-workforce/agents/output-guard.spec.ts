import { guardDraft, GuardInput } from './output-guard';
import { VerifiedFact } from '../crm-workforce.types';

const prov = {
  sourceRecordId: 'r1',
  asOf: '2026-11-18T15:00:00Z',
  verified: true,
  rooftopId: 'l1',
};
const inv: VerifiedFact = {
  ...prov,
  kind: 'inventory',
  text: '2026 Nissan Rogue SV, stock N1234, available. https://www.dialnissan.com/vdp/N1234',
};
const g = (text: string, p: Partial<GuardInput> = {}) =>
  guardDraft({
    text,
    channel: 'SMS',
    facts: [],
    priorAgentMessages: [],
    agentDisplayName: 'Sarah',
    mustDisclose: false,
    appointmentConfirmed: false,
    ...p,
  }).map((v) => v.rule);

describe('draft output guard', () => {
  it('passes a short, plain, sourced reply', () => {
    expect(
      g(
        'Yes, the Rogue SV is still here. Would tomorrow afternoon work to see it?',
        { facts: [inv] },
      ),
    ).toEqual([]);
  });
  it('rejects long texts, lists, emojis, filler and multiple questions', () => {
    expect(g('One. Two. Three.')).toContain('too_many_sentences');
    expect(g('Great question! I would be glad to help.')).toContain(
      'corporate_filler',
    );
    expect(g('Sounds good 🙂')).toContain('emoji');
    expect(g('When works? Morning or afternoon?')).toContain(
      'more_than_one_question',
    );
    expect(g('Options:\n- Monday\n- Tuesday')).toContain('list_formatting');
    expect(g('Awesome! See what we have! ')).toContain('excess_enthusiasm');
  });
  it('rejects false urgency and pressure', () => {
    expect(g("This one won't last, come in now.")).toContain('false_urgency');
  });
  it('rejects price, payment, rate and availability claims without a verified source', () => {
    expect(g('It is $24,995.')).toContain('unsourced_price_or_payment');
    expect(g('We can do 3.9% APR.')).toContain('unsourced_price_or_payment');
    expect(g('Yes, it is still available.')).toContain(
      'unsourced_availability',
    );
    expect(g('Yes, it is still available.', { facts: [inv] })).not.toContain(
      'unsourced_availability',
    );
    expect(
      g('It is still available.', { facts: [{ ...inv, verified: false }] }),
    ).toContain('unsourced_availability');
  });
  it('never allows approval or trade-value promises, even with facts', () => {
    expect(g("You're approved, come sign.", { facts: [inv] })).toContain(
      'credit_approval_promise',
    );
    expect(g('Your trade-in is worth 9000.', { facts: [inv] })).toContain(
      'trade_value_promise',
    );
  });
  it('rejects "booked" language unless the appointment is confirmed', () => {
    expect(g("You're all set for 3pm tomorrow.")).toContain(
      'unconfirmed_appointment_claim',
    );
    expect(
      g("You're all set for 3pm tomorrow.", { appointmentConfirmed: true }),
    ).not.toContain('unconfirmed_appointment_claim');
  });
  it('rejects mechanical diagnosis, safety assurance and fitment guarantees', () => {
    expect(g("Sounds like the alternator. It's fine to drive.")).toContain(
      'diagnosis_or_fitment_assurance',
    );
    expect(g('Those mats will fit your Jeep.')).toContain(
      'diagnosis_or_fitment_assurance',
    );
  });
  it('rejects impersonation and invented experience; requires disclosure on first contact', () => {
    expect(g("I'm a real person, promise.")).toContain('impersonation');
    expect(g('When I drove this one it felt great.')).toContain(
      'impersonation',
    );
    expect(
      g('This is Sarah at Dial Nissan.', { mustDisclose: true }),
    ).toContain('missing_virtual_disclosure');
    expect(
      g("This is Sarah, Dial Nissan's virtual assistant.", {
        mustDisclose: true,
      }),
    ).toEqual([]);
  });
  it('rejects a repeated introduction', () => {
    expect(
      g('This is Sarah again from Dial Nissan.', {
        priorAgentMessages: ["This is Sarah, Dial Nissan's virtual assistant."],
      }),
    ).toContain('repeated_introduction');
  });
  it('allows only links that came from a verified fact', () => {
    expect(g('Details: https://evil.example/login')).toContain(
      'unapproved_link',
    );
    expect(
      g('Details: https://www.dialnissan.com/vdp/N1234.', { facts: [inv] }),
    ).not.toContain('unapproved_link');
  });

  it('an offer to check availability is not a claim of availability', () => {
    for (const ok of [
      "I'll check whether it's still available and get back to you.",
      "I'll have the team see if it is still available.",
      'I will check whether the white Rogue is still here and get back to you.',
      'Let me find out if that 2021 Wrangler is still available.',
      'I can find out if we have it on the lot.',
      "Let me check if it's currently in stock.",
    ])
      expect(g(ok)).not.toContain('unsourced_availability');
    for (const bad of [
      'Yes, it is still available.',
      "Good news, it's available. Come see it.",
      'We have it on the lot today.',
      'I can confirm it is still available.',
      'Let me confirm it is still available for you.',
      "Whether you come today or tomorrow, it's available.",
      "If you like, it's still available and ready.",
      'I checked and it is still available.',
      "If you like it's still available.",
      "If that works for you it's still available.",
      'If that works for you it is still available.',
      'If this suits you we have it.',
      'If the timing works for you it is still here.',
      'Whether you buy or not the white Rogue is still available.',
    ])
      expect(g(bad)).toContain('unsourced_availability');
  });
});
