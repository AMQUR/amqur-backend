import { serializeAdf } from './adf-serializer';
import { validateAdfRoundTrip, validateAdfXml } from './adf-validator';
import { fixtureDto } from './adf-test-fixtures';

const good = serializeAdf(fixtureDto(0));
const code = (xml: unknown, maxBytes?: number) => {
  const r = validateAdfXml(xml, { maxBytes });
  return r.ok ? 'ok' : r.code;
};

describe('hardened ADF validator', () => {
  it('accepts a produced document and reports its structure', () => {
    const r = validateAdfXml(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary).toMatchObject({
      leadRef: 'fixture-dial-chevy-of-chicago-001',
      idSource: 'AMQUR-TEST-ONLY',
      vendorName: 'Dial Chevy of Chicago',
      providerName: 'AMQUR-SYNTHETIC',
      email: 'fixture-1@example.invalid',
      vehicleCount: 1,
    });
  });

  it('rejects DTDs, entity declarations and entity-expansion bombs before parsing', () => {
    const dtd = good.replace(
      '<adf>',
      '<!DOCTYPE adf [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n<adf>',
    );
    expect(code(dtd)).toBe('adf_dtd_forbidden');
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><adf>&lol2;</adf>';
    expect(code(bomb)).toBe('adf_dtd_forbidden');
    expect(code(good.replace('<adf>', '<!ENTITY a "b"><adf>'))).toBe(
      'adf_entity_forbidden',
    );
  });

  it('rejects CDATA, undeclared entities, numeric references and control characters', () => {
    expect(
      code(good.replace('Synthetic', '<![CDATA[<vendor>x</vendor>]]>')),
    ).toBe('adf_cdata_forbidden');
    expect(code(good.replace('Synthetic', '&xxe;'))).toBe(
      'adf_unexpected_entity',
    );
    expect(code(good.replace('Synthetic', '&#x41;'))).toBe(
      'adf_unexpected_entity',
    );
    expect(
      code(good.replace('Synthetic', `Syn${String.fromCharCode(0)}`)),
    ).toBe('adf_illegal_character');
  });

  it('enforces the size cap', () => {
    expect(code(good, 100)).toBe('adf_too_large');
    expect(code('', 100)).toBe('adf_empty');
    expect(code(42)).toBe('adf_empty');
  });

  it('rejects malformed or structurally incomplete documents', () => {
    expect(code(good.replace('</adf>', ''))).toBe('adf_not_well_formed');
    expect(code(good.replace('<?adf version="1.0"?>\n', ''))).toBe(
      'adf_bad_prolog',
    );
    expect(
      code(good.replace('status="new">\n    <id', 'status="old">\n    <id')),
    ).toBe('adf_prospect_status');
    expect(code(good.replace(/ {4}<id .*<\/id>\n/, ''))).toBe('adf_missing_id');
    expect(code(good.replace(/ {4}<requestdate>.*\n/, ''))).toBe(
      'adf_bad_requestdate',
    );
    expect(code(good.replace(/ {4}<vendor>[\s\S]*<\/vendor>\n/, ''))).toBe(
      'adf_missing_vendor',
    );
    expect(code(good.replace('interest="buy"', 'interest="steal"'))).toBe(
      'adf_bad_vehicle_interest',
    );
    const twoProspects = good.replace(
      '</adf>',
      '  <prospect status="new"></prospect>\n</adf>',
    );
    expect(code(twoProspects)).toBe('adf_prospect_count');
  });

  it('round-trip guard fails when the document does not say what the DTO says', () => {
    const dto = fixtureDto(3); // CDJR South
    const xml = serializeAdf(dto);
    expect(validateAdfRoundTrip(dto, xml)).toMatchObject({ ok: true });
    // Same lead, but the vendor swapped for the North store: must not validate.
    const swapped = xml.replace(
      'Dial Chrysler Dodge Jeep Ram of Chicago',
      'Jeep of Chicago',
    );
    expect(validateAdfRoundTrip(dto, swapped)).toEqual({
      ok: false,
      code: 'adf_round_trip_mismatch',
    });
  });
});
