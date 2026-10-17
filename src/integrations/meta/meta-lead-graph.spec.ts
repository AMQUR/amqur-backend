import { parseMetaGraphLeadFieldData } from './meta-lead-graph';

describe('parseMetaGraphLeadFieldData', () => {
  it('maps only verified field_data values', () => {
    const out = parseMetaGraphLeadFieldData([
      { name: 'email', values: ['Lead@Example.com'] },
      { name: 'phone_number', values: ['(555) 123-4567'] },
      { name: 'first_name', values: ['Sam'] },
      { name: 'last_name', values: ['Rivera'] },
      { name: 'zip_code', values: ['90210'] },
    ]);
    expect(out).toEqual({
      firstName: 'Sam',
      lastName: 'Rivera',
      phone: '(555) 123-4567',
      email: 'Lead@Example.com',
      zipCode: '90210',
    });
  });

  it('splits full_name only when separate names are absent', () => {
    expect(
      parseMetaGraphLeadFieldData([
        { name: 'full_name', values: ['Alex Kim'] },
      ]),
    ).toEqual({ firstName: 'Alex', lastName: 'Kim' });
  });

  it('does not invent fields when field_data is empty', () => {
    expect(parseMetaGraphLeadFieldData([])).toEqual({});
    expect(parseMetaGraphLeadFieldData(null)).toEqual({});
  });
});
