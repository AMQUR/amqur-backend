import {
  consentTextFor,
  consentWording,
  isKnownConsentVersion,
  LEAD_FORM_CONSENT_VERSION,
} from './consent-wording';
import {
  buildLeadForm,
  LEAD_FORM_TTL_MS,
  leadFormChannels,
  leadRefusalText,
  LeadSubmissionInput,
  validateLeadSubmission,
} from './lead-form';

const V = LEAD_FORM_CONSENT_VERSION;
const now = new Date('2026-10-13T15:00:00.000Z');

function offer(channels = leadFormChannels(true)) {
  return buildLeadForm({
    purpose: 'test_drive',
    rooftopName: 'Fixture Motors',
    vehicleLabel: '2024 Jeep Wrangler',
    vin: '1C4HJXDG0RW100001',
    channels,
    lang: 'en',
    now,
  });
}

function submission(
  formId: string,
  over: Partial<LeadSubmissionInput> = {},
): LeadSubmissionInput {
  return {
    formId,
    firstName: ' Pat ',
    lastName: 'Rivera',
    email: 'Pat.Rivera@Example.invalid',
    phone: '(312) 555-0142',
    preferredChannel: 'EMAIL',
    consents: [{ channel: 'EMAIL', granted: true, version: V }],
    ...over,
  };
}

describe('lead form card', () => {
  it('offers TEXT only when SMS is enabled', () => {
    expect(leadFormChannels(false)).toEqual(['EMAIL', 'CALL']);
    expect(leadFormChannels(true)).toEqual(['EMAIL', 'CALL', 'TEXT']);
  });

  it('carries versioned wording for exactly the offered channels (EN/ES)', () => {
    const { card, offered } = offer(['EMAIL', 'CALL']);
    expect(card.id).toMatch(/^lf_[A-Za-z0-9_-]{16}$/);
    expect(card.consent.version).toBe(V);
    expect(Object.keys(card.consent.text)).toEqual(['EMAIL', 'CALL']);
    expect(offered).toMatchObject({ id: card.id, consentVersion: V });
    const es = consentTextFor(['EMAIL', 'CALL', 'TEXT'], 'es');
    expect(es.TEXT).toMatch(/responda STOP/);
    expect(es.EMAIL).not.toBe(card.consent.text.EMAIL);
    // the TEXT wording keeps the rate + STOP disclosures and makes no legal claim
    const text = consentWording(V, 'en', 'TEXT')!;
    expect(text).toMatch(/Msg & data rates may apply; reply STOP anytime/);
    for (const w of Object.values(
      consentTextFor(['EMAIL', 'CALL', 'TEXT'], 'en'),
    ))
      expect(w).not.toMatch(/TCPA|compliant|legally|safe harbo/i);
  });

  it('keeps the id of a form that is still waiting for an answer (same language, not expired)', () => {
    const a = offer();
    const again = (lang: 'en' | 'es', at: Date) =>
      buildLeadForm({
        purpose: 'test_drive',
        rooftopName: 'Fixture Motors',
        channels: a.offered.channels,
        lang,
        now: at,
        reuse: a.offered,
      });
    const later = new Date(now.getTime() + 60_000);
    const b = again('en', later);
    expect(b.card.id).toBe(a.card.id);
    // Re-showing the form restarts its validity window (R12).
    expect(b.offered.issuedAt).toBe(later.toISOString());
    expect(b.offered.language).toBe('en');
    // R12: a different language is a different form — one id never means two wordings.
    const es = again('es', later);
    expect(es.card.id).not.toBe(a.card.id);
    expect(es.offered.language).toBe('es');
    // R12: an expired form is not kept alive.
    const stale = again('en', new Date(now.getTime() + LEAD_FORM_TTL_MS + 1));
    expect(stale.card.id).not.toBe(a.card.id);
  });

  it('recognises only published consent versions', () => {
    expect(isKnownConsentVersion(V)).toBe(true);
    expect(isKnownConsentVersion('lead-form-consent-v0')).toBe(false);
    expect(isKnownConsentVersion('toString')).toBe(false);
    expect(isKnownConsentVersion(undefined)).toBe(false);
    expect(consentWording('nope', 'en', 'EMAIL')).toBeNull();
  });
});

describe('validateLeadSubmission', () => {
  const { offered } = offer();

  it('accepts a granted preferred channel and keeps only consented details', () => {
    const r = validateLeadSubmission(submission(offered.id), offered, 'en');
    expect(r).toEqual({
      ok: true,
      contact: {
        firstName: 'Pat',
        lastName: 'Rivera',
        email: 'pat.rivera@example.invalid',
        preferredContact: 'email',
        consentToText: false,
      },
      language: 'en',
      grants: [
        {
          channel: 'EMAIL',
          ledgerChannel: 'EMAIL',
          endpoint: 'pat.rivera@example.invalid',
          wording: consentWording(V, 'en', 'EMAIL'),
          version: V,
        },
      ],
    });
  });

  it('records one grant per ticked channel and maps TEXT to the SMS ledger', () => {
    const r = validateLeadSubmission(
      submission(offered.id, {
        preferredChannel: 'TEXT',
        consents: [
          { channel: 'EMAIL', granted: false, version: V },
          { channel: 'CALL', granted: true, version: V },
          { channel: 'TEXT', granted: true, version: V },
        ],
      }),
      offered,
      'es',
    );
    if (!r.ok) throw new Error(r.reason);
    expect(
      r.grants.map((g) => [g.channel, g.ledgerChannel, g.endpoint]),
    ).toEqual([
      ['CALL', 'CALL', '3125550142'],
      ['TEXT', 'SMS', '3125550142'],
    ]);
    // R12: the stored wording is the one that was SHOWN (the form was issued in English), not
    // the language the client claims at submit time. (This used to assert the Spanish text.)
    expect(r.language).toBe('en');
    expect(r.grants[1].wording).toBe(consentWording(V, 'en', 'TEXT'));
    expect(r.contact).toEqual({
      firstName: 'Pat',
      lastName: 'Rivera',
      phone: '3125550142',
      preferredContact: 'sms',
      consentToText: true,
    });
  });

  it.each([
    ['unknown_form', { formId: 'lf_someone_elses_form' }],
    ['name_required', { firstName: '   ' }],
    ['name_required', { lastName: '123-45-6789' }],
    ['invalid_email', { email: 'not-an-email' }],
    ['invalid_phone', { phone: '555-0142' }],
    ['invalid_phone', { phone: '+44 20 7946 0958' }],
    [
      'preferred_detail_missing',
      { preferredChannel: 'CALL', phone: undefined },
    ],
    ['consent_required', { consents: [] }],
    [
      'consent_required',
      { consents: [{ channel: 'EMAIL', granted: false, version: V }] },
    ],
    [
      'consent_required',
      { consents: [{ channel: 'EMAIL', granted: true, version: 'v-unknown' }] },
    ],
    [
      'consent_required',
      // consent for a different channel does not cover the preferred one
      { consents: [{ channel: 'CALL', granted: true, version: V }] },
    ],
    [
      'consent_required',
      {
        consents: [{ channel: 'EMAIL', granted: 'true' as never, version: V }],
      },
    ],
  ] as Array<[string, Partial<LeadSubmissionInput>]>)(
    'refuses with %s',
    (reason, over) => {
      expect(
        validateLeadSubmission(submission(offered.id, over), offered, 'en'),
      ).toEqual({ ok: false, reason });
    },
  );

  it('refuses a channel the rooftop did not offer, and a missing form', () => {
    const noSms = offer(['EMAIL', 'CALL']).offered;
    expect(
      validateLeadSubmission(
        submission(noSms.id, {
          preferredChannel: 'TEXT',
          consents: [{ channel: 'TEXT', granted: true, version: V }],
        }),
        noSms,
        'en',
      ),
    ).toEqual({ ok: false, reason: 'channel_not_offered' });
    expect(
      validateLeadSubmission(submission(offered.id), undefined, 'en'),
    ).toEqual({ ok: false, reason: 'unknown_form' });
  });

  it('ignores a ticked-but-unoffered or detail-less channel instead of recording it', () => {
    const noSms = offer(['EMAIL', 'CALL']).offered;
    const r = validateLeadSubmission(
      submission(noSms.id, {
        phone: undefined,
        consents: [
          { channel: 'EMAIL', granted: true, version: V },
          { channel: 'CALL', granted: true, version: V }, // no phone given
          { channel: 'TEXT', granted: true, version: V }, // not offered
        ],
      }),
      noSms,
      'en',
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.grants.map((g) => g.channel)).toEqual(['EMAIL']);
    expect(r.contact).not.toHaveProperty('phone');
  });

  it('refusal text never echoes what was typed', () => {
    for (const reason of [
      'unknown_form',
      'name_required',
      'invalid_email',
      'invalid_phone',
      'channel_not_offered',
      'preferred_detail_missing',
      'consent_required',
    ] as const)
      for (const lang of ['en', 'es'] as const) {
        const text = leadRefusalText(reason, lang);
        expect(text.length).toBeLessThan(140);
        expect(text).not.toMatch(/@|\d{3}/);
      }
  });
});

describe('R12 — the form carries its own language and expires', () => {
  const spanish = buildLeadForm({
    purpose: 'sales',
    rooftopName: 'Fixture Motors',
    channels: leadFormChannels(false),
    lang: 'es',
    now,
  }).offered;

  it('wording comes from the language the form was issued in, whatever the submit language', () => {
    const r = validateLeadSubmission(
      submission(spanish.id),
      spanish,
      'en',
      now,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.language).toBe('es');
    expect(r.grants[0].wording).toBe(consentWording(V, 'es', 'EMAIL'));
  });

  it('a form offered before the language was stored falls back to the turn language', () => {
    const legacy = { ...spanish, language: undefined };
    const r = validateLeadSubmission(submission(legacy.id), legacy, 'en', now);
    if (!r.ok) throw new Error(r.reason);
    expect(r.language).toBe('en');
  });

  it('a submission after the validity window is refused and stores nothing', () => {
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(
      validateLeadSubmission(
        submission(spanish.id),
        spanish,
        'es',
        at(LEAD_FORM_TTL_MS),
      ).ok,
    ).toBe(true);
    expect(
      validateLeadSubmission(
        submission(spanish.id),
        spanish,
        'es',
        at(LEAD_FORM_TTL_MS + 1),
      ),
    ).toEqual({ ok: false, reason: 'form_expired' });
    expect(
      validateLeadSubmission(
        submission(spanish.id),
        { ...spanish, issuedAt: 'not-a-date' },
        'es',
        now,
      ),
    ).toEqual({ ok: false, reason: 'form_expired' });
    expect(leadRefusalText('form_expired', 'en')).toMatch(
      /expired, so I haven’t saved anything/,
    );
    expect(leadRefusalText('form_expired', 'es')).toMatch(/venció/);
  });
});
