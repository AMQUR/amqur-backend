import { AdfLeadDto } from './adf.types';

/** Synthetic, TEST-ONLY data. Never a real customer, vehicle, appointment or mailbox. */
export const ROOFTOP_FIXTURES = [
  {
    slug: 'dial-chevy-of-chicago',
    vendor: 'Dial Chevy of Chicago',
    make: 'Chevrolet',
    model: 'Silverado',
  },
  {
    slug: 'dial-nissan-of-chicago',
    vendor: 'Dial Nissan of Chicago',
    make: 'Nissan',
    model: 'Rogue',
  },
  {
    slug: 'infiniti-of-chicago',
    vendor: 'INFINITI of Chicago',
    make: 'INFINITI',
    model: 'QX60',
  },
  {
    // CDJR SOUTH
    slug: 'dial-cdjr-of-chicago',
    vendor: 'Dial Chrysler Dodge Jeep Ram of Chicago',
    make: 'Jeep',
    model: 'Grand Cherokee',
  },
  {
    // Jeep NORTH
    slug: 'jeep-of-chicago',
    vendor: 'Jeep of Chicago',
    make: 'Jeep',
    model: 'Grand Cherokee',
  },
] as const;

export function fixtureDto(
  i: number,
  over: Partial<AdfLeadDto> = {},
): AdfLeadDto {
  const r = ROOFTOP_FIXTURES[i];
  return {
    leadRef: `fixture-${r.slug}-00${i + 1}`,
    idSource: 'AMQUR-TEST-ONLY',
    requestDate: '2026-11-18T10:00:00Z',
    vehicles: [
      { interest: 'buy', status: 'new', make: r.make, model: r.model },
    ],
    customer: {
      firstName: 'Synthetic',
      lastName: 'Customer',
      email: `fixture-${i + 1}@example.invalid`,
    },
    comments: {
      department: 'SALES',
      consent: { text: null, email: null, call: null },
      source: 'test_fixture',
    },
    vendorName: r.vendor,
    providerName: 'AMQUR-SYNTHETIC',
    ...over,
  };
}
