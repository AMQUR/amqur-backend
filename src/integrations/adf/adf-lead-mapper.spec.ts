import { mapLeadToAdf, MapperLead } from './adf-lead-mapper';
import { serializeAdf } from './adf-serializer';

const lead = (over: Partial<MapperLead> = {}): MapperLead => ({
  id: 'lead1',
  createdAt: new Date('2026-11-18T10:00:00Z'),
  firstName: 'Synthetic',
  lastName: 'Customer',
  email: 'synthetic@example.invalid',
  phone: '312-555-0142',
  interestedVin: null,
  interestedStock: null,
  preferredContact: 'phone',
  leaseVsPurchase: null,
  consentToText: false,
  consentToEmail: false,
  consentToCall: false,
  optOutAt: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  source: 'widget',
  nextBestAction: 'INTERNAL scoring note that must not leave AMQUR',
  ...over,
});
const map = (p: Partial<Parameters<typeof mapLeadToAdf>[0]> = {}) =>
  mapLeadToAdf({
    lead: lead(),
    department: 'SALES',
    vendorName: 'Jeep of Chicago',
    providerName: 'AMQUR AI',
    vehicle: null,
    appointment: null,
    ...p,
  });

describe('lead → ADF DTO mapper', () => {
  it('uses a stable AMQUR reference and the lead creation time', () => {
    const dto = map();
    expect(dto.leadRef).toBe('amqur-lead-lead1');
    expect(dto.idSource).toBe('AMQUR');
    expect(dto.requestDate).toBe('2026-11-18T10:00:00.000Z');
    expect(dto.vendorName).toBe('Jeep of Chicago');
    expect(serializeAdf(dto)).toBe(serializeAdf(map()));
  });

  it('no known vehicle → no vehicle element at all', () => {
    expect(map().vehicles).toEqual([]);
    expect(serializeAdf(map())).not.toContain('<vehicle');
  });

  it('a VIN that is not in the rooftop inventory passes through as VIN only', () => {
    const dto = map({ lead: lead({ interestedVin: '1C4RJFBG0MC100001' }) });
    expect(dto.vehicles).toEqual([
      { interest: 'buy', vin: '1C4RJFBG0MC100001', stock: undefined },
    ]);
    const xml = serializeAdf(dto);
    expect(xml).not.toContain('<make');
    expect(xml).not.toMatch(/<vehicle[^>]*status=/);
  });

  it('inventory facts come only from the matched inventory row', () => {
    const dto = map({
      lead: lead({
        interestedVin: '1C4RJFBG0MC100001',
        leaseVsPurchase: 'lease',
      }),
      vehicle: {
        vin: '1C4RJFBG0MC100001',
        stock: 'TEST1001',
        year: 2026,
        make: 'Jeep',
        model: 'Grand Cherokee',
        trim: 'Limited',
        condition: 'certified',
      },
    });
    expect(dto.vehicles[0]).toMatchObject({
      interest: 'lease',
      status: 'used',
      year: 2026,
      make: 'Jeep',
      model: 'Grand Cherokee',
      trim: 'Limited',
      stock: 'TEST1001',
    });
    // Unknown condition stays unknown.
    expect(
      map({
        vehicle: {
          vin: '1C4RJFBG0MC100001',
          stock: null,
          year: 2026,
          make: 'Jeep',
          model: 'Compass',
          trim: null,
          condition: null,
        },
      }).vehicles[0].status,
    ).toBeUndefined();
  });

  it('service and parts leads never carry a sales vehicle block', () => {
    const dto = map({
      department: 'SERVICE',
      lead: lead({
        interestedVin: '1C4RJFBG0MC100001',
        source: 'widget_service',
      }),
    });
    expect(dto.vehicles).toEqual([]);
    expect(dto.comments.department).toBe('SERVICE');
  });

  it('a requested appointment is carried as requested, never confirmed', () => {
    const xml = serializeAdf(
      map({
        appointment: {
          type: 'TEST_DRIVE',
          status: 'REQUESTED',
          availabilityVerified: false,
          requestedDate: '2026-11-21',
          requestedTime: '15:00',
          scheduledAt: null,
          timezone: 'America/Chicago',
        },
      }),
    );
    expect(xml).toContain(
      'Appointment: REQUESTED by customer - NOT confirmed, dealership must confirm (TEST_DRIVE 2026-11-21 15:00)',
    );
    expect(xml).not.toContain('CONFIRMED by dealership');
    const confirmed = serializeAdf(
      map({
        appointment: {
          type: 'SALES',
          status: 'CONFIRMED',
          availabilityVerified: true,
          requestedDate: '2026-11-21',
          requestedTime: '15:00',
          scheduledAt: new Date('2026-11-21T21:00:00Z'),
          timezone: 'America/Chicago',
        },
      }),
    );
    expect(confirmed).toContain('Appointment: CONFIRMED by dealership');
  });

  it('consent is reported as recorded / not recorded; opt-out wins; internal notes stay internal', () => {
    expect(map().comments.consent).toEqual({
      text: null,
      email: null,
      call: null,
    });
    expect(
      map({ lead: lead({ consentToText: true }) }).comments.consent.text,
    ).toBe(true);
    expect(
      map({ lead: lead({ consentToText: true }) }).customer.phoneType,
    ).toBe('cellphone');
    expect(
      map({ lead: lead({ consentToText: true, optOutAt: new Date() }) })
        .comments.consent,
    ).toEqual({ text: false, email: false, call: false });
    expect(serializeAdf(map())).not.toContain('INTERNAL scoring note');
  });
});
