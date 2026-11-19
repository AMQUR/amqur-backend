import {
  AdfSerializationError,
  buildAdfComments,
  describeAppointment,
  escapeXml,
  sanitizeAdfText,
  serializeAdf,
} from './adf-serializer';
import { validateAdfRoundTrip, validateAdfXml } from './adf-validator';
import { fixtureDto, ROOFTOP_FIXTURES } from './adf-test-fixtures';
import { AdfLeadDto } from './adf.types';

const chr = (cp: number) => String.fromCodePoint(cp);
const ok = (dto: AdfLeadDto) => {
  const xml = serializeAdf(dto);
  const res = validateAdfRoundTrip(dto, xml);
  if (!res.ok) throw new Error(`round trip failed: ${res.code}`);
  return { xml, summary: res.summary };
};

describe('ADF 1.0 serializer', () => {
  it.each(ROOFTOP_FIXTURES.map((r, i) => [r.slug, i] as const))(
    'rooftop fixture %s: exact document, own vendor name only',
    (slug, i) => {
      const r = ROOFTOP_FIXTURES[i];
      const { xml, summary } = ok(fixtureDto(i));
      expect(xml).toBe(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<?adf version="1.0"?>',
          '<adf>',
          '  <prospect status="new">',
          `    <id sequence="1" source="AMQUR-TEST-ONLY">fixture-${slug}-00${i + 1}</id>`,
          '    <requestdate>2026-11-18T10:00:00.000Z</requestdate>',
          '    <vehicle interest="buy" status="new">',
          `      <make>${r.make}</make>`,
          `      <model>${r.model}</model>`,
          '    </vehicle>',
          '    <customer>',
          '      <contact>',
          '        <name part="first">Synthetic</name>',
          '        <name part="last">Customer</name>',
          `        <email>fixture-${i + 1}@example.invalid</email>`,
          '      </contact>',
          '      <comments>Department: SALES; Appointment: none requested; Consent: text=not recorded, email=not recorded, call=not recorded; Source: test_fixture</comments>',
          '    </customer>',
          '    <vendor>',
          `      <vendorname>${r.vendor}</vendorname>`,
          '    </vendor>',
          '    <provider>',
          '      <name>AMQUR-SYNTHETIC</name>',
          '    </provider>',
          '  </prospect>',
          '</adf>',
          '',
        ].join('\n'),
      );
      expect(summary.vendorName).toBe(r.vendor);
      for (const other of ROOFTOP_FIXTURES)
        if (other.vendor !== r.vendor)
          expect(xml).not.toContain(`<vendorname>${other.vendor}<`);
    },
  );

  it('CDJR South and Jeep North share a make/model but never a vendor', () => {
    const south = serializeAdf(fixtureDto(3));
    const north = serializeAdf(fixtureDto(4));
    expect(south).toContain(
      '<vendorname>Dial Chrysler Dodge Jeep Ram of Chicago</vendorname>',
    );
    expect(south).not.toContain('<vendorname>Jeep of Chicago</vendorname>');
    expect(north).toContain('<vendorname>Jeep of Chicago</vendorname>');
    expect(north).not.toContain('Chrysler');
  });

  it('is deterministic: same input, same bytes', () => {
    const a = serializeAdf(fixtureDto(0));
    const b = serializeAdf(JSON.parse(JSON.stringify(fixtureDto(0))));
    expect(a).toBe(b);
  });

  it('no-contact lead: empty contact, nothing invented', () => {
    const { xml, summary } = ok(fixtureDto(0, { customer: {} }));
    expect(xml).toContain('      <contact>\n      </contact>');
    expect(xml).not.toContain('<name part');
    expect(xml).not.toContain('<email');
    expect(xml).not.toContain('<phone');
    expect(summary.email).toBeNull();
    expect(summary.phone).toBeNull();
  });

  it('phone-only lead carries a typed phone and no email', () => {
    const { xml } = ok(
      fixtureDto(1, {
        customer: { firstName: 'Synthetic', phone: '312-555-0142' },
      }),
    );
    expect(xml).toContain('<phone type="voice">312-555-0142</phone>');
    expect(xml).not.toContain('<email');
    expect(xml).not.toContain('part="last"');
    const cell = serializeAdf(
      fixtureDto(1, {
        customer: { phone: '312-555-0142', phoneType: 'cellphone' },
      }),
    );
    expect(cell).toContain('<phone type="cellphone">312-555-0142</phone>');
  });

  it('email-only lead carries the email and no phone', () => {
    const { xml } = ok(
      fixtureDto(2, { customer: { email: 'Only.Email@Example.INVALID' } }),
    );
    expect(xml).toContain('<email>only.email@example.invalid</email>');
    expect(xml).not.toContain('<phone');
  });

  it('omits unknown vehicle facts instead of emitting placeholders', () => {
    const none = serializeAdf(fixtureDto(0, { vehicles: [] }));
    expect(none).not.toContain('<vehicle');
    const vinOnly = serializeAdf(
      fixtureDto(0, {
        vehicles: [{ interest: 'buy', vin: '1C4RJFBG0MC100001' }],
      }),
    );
    expect(vinOnly).toContain('<vehicle interest="buy">');
    expect(vinOnly).not.toContain('status="new">\n      <vin');
    expect(vinOnly).not.toMatch(/<vehicle[^>]*status=/);
    expect(vinOnly).not.toContain('<year');
    expect(vinOnly).not.toContain('<make');
    expect(vinOnly).not.toContain('<model');
    // A vehicle with no usable fact is dropped entirely.
    const empty = serializeAdf(
      fixtureDto(0, {
        vehicles: [{ interest: 'buy', vin: 'not a vin!', year: 12 }],
      }),
    );
    expect(empty).not.toContain('<vehicle');
  });

  it('multiple vehicles plus a trade-in keep their own interest/status', () => {
    const { xml, summary } = ok(
      fixtureDto(3, {
        vehicles: [
          {
            interest: 'buy',
            status: 'new',
            year: 2026,
            make: 'Jeep',
            model: 'Grand Cherokee',
            trim: 'Limited',
            vin: '1C4RJFBG0MC100001',
            stock: 'TEST1001',
          },
          { interest: 'lease', status: 'new', make: 'Jeep', model: 'Compass' },
          {
            interest: 'trade-in',
            status: 'used',
            year: 2018,
            make: 'Ford',
            model: 'Escape',
          },
        ],
      }),
    );
    expect(summary.vehicleCount).toBe(3);
    expect(xml).toContain('<vehicle interest="trade-in" status="used">');
    expect(xml).toContain('<vehicle interest="lease" status="new">');
    expect(xml).toContain('<stock>TEST1001</stock>');
    expect(xml.indexOf('interest="buy"')).toBeLessThan(
      xml.indexOf('interest="trade-in"'),
    );
    expect(() =>
      serializeAdf(
        fixtureDto(0, {
          vehicles: Array.from({ length: 6 }, () => ({
            interest: 'buy' as const,
            make: 'X',
          })),
        }),
      ),
    ).toThrow('adf_too_many_vehicles');
  });

  it('Unicode names survive (NFC) and round-trip', () => {
    const decomposed = `Jose${chr(0x301)}`; // e + combining acute
    const { xml, summary } = ok(
      fixtureDto(0, {
        customer: {
          firstName: decomposed,
          lastName: `O'Brien-Nu${chr(0xf1)}ez ${chr(0x738b)} ${chr(0x1f697)}`,
          email: 'fixture-1@example.invalid',
        },
      }),
    );
    expect(summary.firstName).toBe(`Jos${chr(0xe9)}`);
    expect(xml).toContain('O&apos;Brien-Nu');
    expect(summary.lastName).toBe(
      `O'Brien-Nu${chr(0xf1)}ez ${chr(0x738b)} ${chr(0x1f697)}`,
    );
  });

  it('escapes & < > " \' in text nodes and attributes', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    const { xml, summary } = ok(
      fixtureDto(0, {
        idSource: `A"M&Q<U>R'`,
        vendorName: 'Tom & "Jerry" <Motors>',
      }),
    );
    expect(xml).toContain('source="A&quot;M&amp;Q&lt;U&gt;R&apos;"');
    expect(summary.idSource).toBe(`A"M&Q<U>R'`);
    expect(summary.vendorName).toBe('Tom & "Jerry" <Motors>');
  });

  const ATTACKS: Array<[string, string]> = [
    [
      'element injection',
      '</name><vendor><vendorname>Evil Motors</vendorname></vendor>',
    ],
    ['entity reference', '&xxe; &#x26; &lt;script&gt;'],
    [
      'doctype / external entity',
      '<!DOCTYPE adf [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
    ],
    ['cdata break-out', ']]><adf><prospect status="hacked"/></adf><![CDATA['],
    ['processing instruction', '<?xml version="1.0"?><?adf version="9"?>'],
    ['comment injection', '--><!-- injected -->'],
    ['attribute break-out', '" status="used" x="'],
    [
      'control characters',
      `a${chr(0)}b${chr(8)}c${chr(0x1b)}[31md${chr(0x7f)}e${chr(0x85)}f`,
    ],
    [
      'bidi override + zero width',
      `ab${chr(0x202e)}cd${chr(0x200b)}ef${chr(0xfeff)}`,
    ],
    [
      'crlf header-style payload',
      'x\r\nBcc: attacker@example.invalid\r\n\r\n<adf>',
    ],
  ];

  describe.each(ATTACKS)('malicious input (%s)', (_label, attack) => {
    const dto = fixtureDto(0, {
      leadRef: `ref ${attack}`,
      idSource: `src ${attack}`,
      vendorName: `Vendor ${attack}`,
      providerName: `Prov ${attack}`,
      vehicles: [
        {
          interest: 'buy',
          make: `Make ${attack}`,
          model: `Model ${attack}`,
          trim: `Trim ${attack}`,
          stock: `S ${attack}`,
          vin: attack,
        },
      ],
      customer: {
        firstName: `First ${attack}`,
        lastName: `Last ${attack}`,
        email: attack,
        phone: `312-555-0142 ${attack}`,
      },
      comments: {
        department: 'SALES',
        requestedAction: attack,
        preferredContact: attack,
        appointment: {
          status: 'REQUESTED',
          availabilityVerified: false,
          type: attack,
          when: attack,
        },
        consent: { text: true, email: null, call: false },
        source: attack,
        utmSource: attack,
        utmMedium: attack,
        utmCampaign: attack,
      },
    });

    it('stays one well-formed prospect whose text round-trips as text', () => {
      const xml = serializeAdf(dto);
      const res = validateAdfRoundTrip(dto, xml);
      expect(res).toMatchObject({ ok: true });
      if (!res.ok) return;
      expect(res.summary.vehicleCount).toBe(1);
      expect(res.summary.vendorName.startsWith('Vendor')).toBe(true);
      expect(res.summary.vendorName).not.toBe('Evil Motors');
      // No markup construct can come from user text.
      expect(xml).not.toMatch(/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<!--/);
      expect(xml.match(/<\?/g)).toHaveLength(2);
      expect(xml.match(/<prospect /g)).toHaveLength(1);
      expect(xml.match(/<vendorname>/g)).toHaveLength(1);
      expect(xml.match(/<vehicle /g)).toHaveLength(1);
      // eslint-disable-next-line no-control-regex
      expect(xml).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x85]/);
      expect(xml).not.toContain(chr(0x202e));
      expect(xml).not.toContain(chr(0x200b));
      expect(xml).not.toContain('\r');
      // A hostile email/VIN is dropped, not passed through.
      expect(xml).not.toContain('<email>');
      expect(xml).not.toContain('<vin>');
    });
  });

  it('strips control characters and collapses whitespace', () => {
    expect(sanitizeAdfText(`  a${chr(0)}\t\r\n b  ${chr(0x1f)}c  `, 50)).toBe(
      'a b c',
    );
    expect(sanitizeAdfText(`${chr(0xd800)}x`, 10)).toBe('x'); // lone surrogate
    expect(sanitizeAdfText('abcdef', 3)).toBe('abc');
    expect(sanitizeAdfText(undefined, 3)).toBe('');
  });

  it('enforces the hard size cap', () => {
    const big = fixtureDto(0);
    expect(() => serializeAdf(big, { maxBytes: 200 })).toThrow(
      AdfSerializationError,
    );
    expect(() => serializeAdf(big, { maxBytes: 200 })).toThrow('adf_too_large');
    // Oversized user text is truncated per field, so the document stays under the default cap.
    const huge = 'x'.repeat(500_000);
    const xml = serializeAdf(
      fixtureDto(0, {
        vendorName: `V${huge}`,
        customer: { firstName: huge, lastName: huge },
        comments: {
          department: 'SALES',
          requestedAction: huge,
          consent: { text: null, email: null, call: null },
          source: huge,
          utmCampaign: huge,
        },
      }),
    );
    expect(Buffer.byteLength(xml, 'utf8')).toBeLessThan(8 * 1024);
  });

  it('rejects a DTO without the required identity', () => {
    expect(() => serializeAdf(fixtureDto(0, { leadRef: ' ' }))).toThrow(
      'adf_missing_lead_ref',
    );
    expect(() => serializeAdf(fixtureDto(0, { vendorName: '' }))).toThrow(
      'adf_missing_vendor',
    );
    expect(() =>
      serializeAdf(fixtureDto(0, { requestDate: 'yesterday' })),
    ).toThrow('adf_bad_request_date');
  });

  describe('comments', () => {
    const base = {
      department: 'SALES' as const,
      consent: { text: null, email: null, call: null },
    };

    it('a REQUESTED appointment is never described as confirmed', () => {
      for (const status of [
        'REQUESTED',
        'PENDING_CONFIRMATION',
        'RESCHEDULED',
      ] as const) {
        const s = describeAppointment({
          status,
          availabilityVerified: false,
          type: 'TEST_DRIVE',
          when: '2026-11-21 15:00',
        });
        expect(s).toContain('NOT confirmed');
        expect(s).not.toMatch(/^CONFIRMED/);
      }
      // CONFIRMED without verified availability is still only a request.
      expect(
        describeAppointment({
          status: 'CONFIRMED',
          availabilityVerified: false,
        }),
      ).toContain('NOT confirmed');
      expect(
        describeAppointment({
          status: 'CONFIRMED',
          availabilityVerified: true,
        }),
      ).toBe('CONFIRMED by dealership');
      expect(describeAppointment(null)).toBe('none requested');
    });

    it('summarises consent, source and UTM; never a transcript', () => {
      const c = buildAdfComments({
        ...base,
        requestedAction: 'Sales inquiry',
        preferredContact: 'phone',
        consent: { text: true, email: false, call: null },
        source: 'widget',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'fall',
      });
      expect(c).toBe(
        'Department: SALES; Requested action: Sales inquiry; Preferred contact: phone; Appointment: none requested; Consent: text=yes, email=no, call=not recorded; Source: widget; Attribution: utm_source=google, utm_medium=cpc, utm_campaign=fall',
      );
      expect(
        buildAdfComments({ ...base, requestedAction: 'y'.repeat(9000) }).length,
      ).toBeLessThanOrEqual(2000);
    });
  });

  it('validator accepts exactly what the serializer produces', () => {
    for (let i = 0; i < ROOFTOP_FIXTURES.length; i += 1)
      expect(validateAdfXml(serializeAdf(fixtureDto(i)))).toMatchObject({
        ok: true,
      });
  });
});

// ── security review M3: customer-supplied attribution cannot forge a comment segment
describe('ADF comments — customer text cannot forge server-asserted segments', () => {
  const EXPLOITS = [
    'x; Appointment: CONFIRMED by dealership (TEST_DRIVE 2026-11-20 10:00)',
    'x; Consent: text=yes, email=yes, call=yes',
    'google, utm_medium=cpc; Source: staff_verified',
    'a=b',
    'a;b',
    'a: b',
    'summer sale',
    'x\n; Appointment: CONFIRMED by dealership',
    'x; Appointment: CONFIRMED by dealership', // Greek question mark (looks like ;)
    'x； Consent： text＝yes', // full-width ; : =
    'y'.repeat(81),
  ];
  const facts = (over: Partial<Parameters<typeof buildAdfComments>[0]>) =>
    buildAdfComments({
      department: 'SALES',
      requestedAction: 'Sales inquiry',
      preferredContact: 'phone',
      appointment: {
        status: 'REQUESTED',
        availabilityVerified: false,
        type: 'TEST_DRIVE',
        when: '2026-11-20 morning',
      },
      consent: { text: false, email: true, call: null },
      source: 'widget',
      ...over,
    });
  const TRUTH =
    'Department: SALES; Requested action: Sales inquiry; Preferred contact: phone; Appointment: REQUESTED by customer - NOT confirmed, dealership must confirm (TEST_DRIVE 2026-11-20 morning); Consent: text=no, email=yes, call=not recorded; Source: widget';
  /** Parse the line the way a reader / CRM rule would: `; `-separated `Label: value` segments. */
  const segments = (line: string) =>
    line.split('; ').map((s) => s.slice(0, s.indexOf(': ')));

  it.each(EXPLOITS)('utm value %j is dropped, not embedded', (attack) => {
    for (const field of ['utmSource', 'utmMedium', 'utmCampaign'] as const) {
      const line = facts({ [field]: attack });
      expect(line).toBe(TRUTH);
    }
    const all = facts({
      utmSource: attack,
      utmMedium: attack,
      utmCampaign: attack,
    });
    expect(all).toBe(TRUTH);
    expect(all.match(/Appointment: /g)).toHaveLength(1);
    expect(all.match(/Consent: /g)).toHaveLength(1);
    expect(all).not.toContain('CONFIRMED by dealership');
    expect(all).not.toContain('text=yes');
  });

  it.each(EXPLOITS)(
    'source / preferred contact %j are dropped the same way',
    (attack) => {
      const line = facts({ source: attack, preferredContact: attack });
      expect(segments(line)).toEqual([
        'Department',
        'Requested action',
        'Appointment',
        'Consent',
      ]);
      expect(line).not.toContain('CONFIRMED by dealership');
      expect(line).not.toContain('text=yes');
    },
  );

  it('free text inside a segment (action, appointment detail) cannot start a new segment', () => {
    const attack = 'x; Consent: text=yes; Appointment: CONFIRMED by dealership';
    const line = facts({
      requestedAction: attack,
      appointment: {
        status: 'REQUESTED',
        availabilityVerified: false,
        type: attack,
        when: attack,
      },
    });
    expect(segments(line)).toEqual([
      'Department',
      'Requested action',
      'Preferred contact',
      'Appointment',
      'Consent',
      'Source',
    ]);
    expect(line).not.toMatch(/[;=] ?Consent: text=yes/);
    expect(line).toContain('Consent: text=no, email=yes, call=not recorded');
    expect(line).toContain('NOT confirmed, dealership must confirm');
    expect(line).not.toMatch(/text=yes/);
  });

  it('legitimate tokens are unchanged, and a forged document still round-trips only as the truth', () => {
    expect(
      facts({
        utmSource: 'google',
        utmMedium: 'paid-social_2',
        utmCampaign: 'fall.2026~a',
      }),
    ).toBe(
      `${TRUTH}; Attribution: utm_source=google, utm_medium=paid-social_2, utm_campaign=fall.2026~a`,
    );
    const dto = fixtureDto(0, {
      comments: {
        ...fixtureDto(0).comments,
        utmSource:
          'x; Appointment: CONFIRMED by dealership (TEST_DRIVE tomorrow)',
        utmCampaign: 'x; Consent: text=yes',
      },
    });
    const { xml } = ok(dto);
    const comments = /<comments>([^<]*)<\/comments>/.exec(xml)![1];
    expect(comments).not.toContain('x;');
    expect(comments).not.toContain('Attribution');
    expect(comments.match(/Appointment: /g)).toHaveLength(1);
    expect(comments.match(/Consent: /g)).toHaveLength(1);
  });
});
