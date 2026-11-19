import {
  LedgerRow,
  resolveLeadConsentStanding,
  StandingLead,
} from './lead-consent-standing';

const EMAIL = 'shopper@example.invalid';
const PHONE = '+13125550142';
const lead = (over: Partial<StandingLead> = {}): StandingLead => ({
  email: EMAIL,
  phone: '(312) 555-0142',
  consentToText: false,
  consentToEmail: false,
  consentToCall: false,
  optOutAt: null,
  ...over,
});
let clock = 0;
const row = (
  channel: string,
  endpoint: string,
  granted: boolean,
  evidence: unknown = {},
): LedgerRow => ({
  channel,
  endpoint,
  granted,
  evidence,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, (clock += 1))),
});

describe('resolveLeadConsentStanding (ADF consent from the ledger)', () => {
  it('no ledger rows: lead flags are opt-ins, everything else is "not recorded"', () => {
    expect(
      resolveLeadConsentStanding(lead({ consentToText: true }), []),
    ).toEqual({
      text: true,
      email: null,
      call: null,
      doNotContact: false,
      reason: 'ok',
    });
  });

  it('a text-only STOP is reported as text=false but does NOT block the CRM hand-off', () => {
    const s = resolveLeadConsentStanding(lead({ consentToText: true }), [
      row('SMS', PHONE, true),
      row('SMS', PHONE, false, { keyword: 'STOP' }),
    ]);
    expect(s).toMatchObject({ text: false, doNotContact: false });
  });

  it('a text STOP on a phone-only lead still does not block (call is not opted out)', () => {
    const s = resolveLeadConsentStanding(lead({ email: null }), [
      row('SMS', PHONE, false),
    ]);
    expect(s).toMatchObject({ text: false, call: null, doNotContact: false });
  });

  it('the latest record per channel wins (STOP then START ⇒ true)', () => {
    const s = resolveLeadConsentStanding(lead(), [
      row('SMS', PHONE, false),
      row('SMS', PHONE, true),
    ]);
    expect(s.text).toBe(true);
  });

  it('email / call grants on the ledger reach the summary without any lead flag', () => {
    const s = resolveLeadConsentStanding(lead(), [
      row('EMAIL', EMAIL, true),
      row('CALL', PHONE, true),
    ]);
    expect(s).toMatchObject({ email: true, call: true, text: null });
  });

  it('every reachable channel opted out ⇒ do not contact', () => {
    expect(
      resolveLeadConsentStanding(lead(), [
        row('EMAIL', EMAIL, false),
        row('SMS', PHONE, false),
        row('CALL', PHONE, false),
      ]),
    ).toMatchObject({ doNotContact: true, reason: 'all_channels_opted_out' });
    expect(
      resolveLeadConsentStanding(lead({ phone: null }), [
        row('EMAIL', EMAIL, false),
      ]),
    ).toMatchObject({ doNotContact: true });
    // …but an email opt-out alone leaves the phone.
    expect(
      resolveLeadConsentStanding(lead(), [row('EMAIL', EMAIL, false)]),
    ).toMatchObject({ email: false, doNotContact: false });
  });

  it('an explicit do-not-contact blocks until a LATER grant on that endpoint', () => {
    const dnc = row('SMS', PHONE, false, { scope: 'ALL' });
    expect(resolveLeadConsentStanding(lead(), [dnc])).toMatchObject({
      doNotContact: true,
      reason: 'explicit_do_not_contact',
      text: false,
      email: false,
      call: false,
    });
    expect(
      resolveLeadConsentStanding(lead(), [
        row('CALL', PHONE, false, { doNotContact: true }),
      ]).doNotContact,
    ).toBe(true);
    expect(
      resolveLeadConsentStanding(lead(), [dnc, row('CALL', PHONE, true)])
        .doNotContact,
    ).toBe(false);
  });

  it('Lead.optOutAt blocks and reports false everywhere', () => {
    expect(
      resolveLeadConsentStanding(
        lead({ optOutAt: new Date(), consentToText: true }),
        [row('SMS', PHONE, true)],
      ),
    ).toEqual({
      text: false,
      email: false,
      call: false,
      doNotContact: true,
      reason: 'lead_opted_out',
    });
  });

  it("another customer's ledger rows are ignored", () => {
    const s = resolveLeadConsentStanding(lead(), [
      row('SMS', '+13125550199', false, { scope: 'ALL' }),
      row('EMAIL', 'someone-else@example.invalid', false),
    ]);
    expect(s).toMatchObject({ text: null, email: null, doNotContact: false });
  });
});
