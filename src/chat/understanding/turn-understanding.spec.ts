import { hasIntent, understandTurn, TurnIntent } from './turn-understanding';

const TZ = 'America/Chicago';
const NOW = new Date('2026-10-13T15:00:00Z'); // Tue 10:00 CDT
const u = (
  m: string,
  ctx: Partial<Parameters<typeof understandTurn>[1]> = {},
) => understandTurn(m, { timeZone: TZ, now: NOW, ...ctx });
const ids = (
  m: string,
  ctx: Partial<Parameters<typeof understandTurn>[1]> = {},
) => u(m, ctx).intents.map((i) => i.intent);

describe('understandTurn — multi-intent', () => {
  it('extracts trade + selection + payment + appointment from one turn', () => {
    const r = u(
      'I have a 2021 Accord to trade, want the black Wrangler you showed me, need to stay under $650 a month, and can come Saturday afternoon.',
      { hasVisibleVehicles: true },
    );
    const got = r.intents.map((i) => i.intent);
    expect(got).toEqual(
      expect.arrayContaining([
        'TRADE_IN',
        'SELECT_VEHICLE',
        'PAYMENT_ESTIMATE',
        'SALES_APPOINTMENT',
      ]),
    );
    expect(got).not.toContain('INVENTORY_SEARCH');
    expect(r.entities.trade).toMatchObject({
      year: 2021,
      make: 'Honda',
      model: 'Accord',
    });
    expect(r.entities.vehicle).toMatchObject({
      model: 'Wrangler',
      color: 'black',
    });
    expect(r.entities.vehicle?.year).toBeUndefined(); // 2021 belongs to the trade
    expect(r.entities.maxMonthly).toBe(650);
    expect(r.entities.when?.date).toEqual({ year: 2026, month: 10, day: 17 });
    expect(r.entities.when?.partOfDay).toBe('afternoon');
  });

  it('acceptance journey turns', () => {
    const t1 = u('Looking for a black Wrangler under 45 grand.');
    expect(t1.primary).toBe('INVENTORY_SEARCH');
    expect(t1.entities.maxPrice).toBe(45000);
    expect(t1.entities.vehicle).toMatchObject({
      make: 'Jeep',
      model: 'Wrangler',
      color: 'black',
    });

    const t2 = u('Which of those has heated seats?', {
      hasVisibleVehicles: true,
    });
    expect(t2.primary).toBe('FEATURE_FILTER');
    expect(t2.entities.features).toEqual(['heated seats']);

    const t3 = u('What would the payment be with 5k down?', {
      hasVisibleVehicles: true,
    });
    expect(t3.primary).toBe('PAYMENT_ESTIMATE');
    expect(t3.entities.downPayment).toBe(5000);

    const t4 = u("I've got a 2021 Accord with 48k miles.");
    expect(t4.primary).toBe('TRADE_IN');
    expect(t4.entities.trade).toMatchObject({
      year: 2021,
      model: 'Accord',
      mileage: 48000,
    });
    expect(t4.entities.vehicle?.model).toBeUndefined();

    const t5 = u('I can come Saturday at 3.', { activeDepartment: 'sales' });
    expect(t5.primary).toBe('SALES_APPOINTMENT');
    expect(t5.entities.when?.time).toBe(15 * 60);

    expect(u('Send me the credit application.').primary).toBe(
      'CREDIT_APPLICATION',
    );
  });

  it('service journey', () => {
    const s1 = u('I need an oil change Friday morning.');
    expect(s1.primary).toBe('SERVICE_APPOINTMENT');
    expect(s1.entities.serviceNeed).toBe('oil change');
    const s2 = u('Actually make it Saturday.', {
      hasActiveAppointment: true,
      activeDepartment: 'service',
    });
    expect(s2.primary).toBe('APPOINTMENT_RESCHEDULE');
    const s3 = u('Do you have a shuttle?', { activeDepartment: 'service' });
    expect(s3.primary).toBe('SERVICE_AMENITY_QUESTION');
    expect(s3.entities.amenity).toBe('shuttle');
  });

  it('parts journey', () => {
    const p = u('I need front brakes for my 2021 Grand Cherokee. How much?');
    expect(p.primary).toBe('PARTS_INQUIRY');
    expect(p.entities.partNeed).toBe('front brakes');
  });

  it('frustrated customer escalates and is flagged', () => {
    const r = u("I'm pissed. I've called twice and nobody is helping me.");
    expect(r.sentiment).toBe('frustrated');
    expect(r.primary).toBe('COMPLAINT');
    expect(r.entities.contact?.firstName).toBeUndefined(); // "I'm pissed" is not a name
  });
});

describe('understandTurn — ambiguous words (adversarial)', () => {
  const cases: Array<[string, TurnIntent | null, TurnIntent[]]> = [
    // open
    ['Are you open on Sunday?', 'HOURS_LOCATION', []],
    ["I'm open to SUVs or trucks", 'INVENTORY_SEARCH', ['HOURS_LOCATION']],
    // close
    ['What time do you close tonight?', 'HOURS_LOCATION', []],
    ['Is there a dealership close to Naperville?', null, ['HOURS_LOCATION']],
    // agent
    ['Can I talk to an agent?', 'HUMAN_HANDOFF', []],
    ['My insurance agent said I need a VIN', null, ['HUMAN_HANDOFF']],
    // new
    ["What's new with the 2027 Tacoma?", null, ['INVENTORY_SEARCH']],
    ['Show me new Tacomas in stock', 'INVENTORY_SEARCH', []],
    // car
    [
      'My car makes a grinding noise when braking',
      'SERVICE_APPOINTMENT',
      ['INVENTORY_SEARCH'],
    ],
    // filter
    ['Can you filter those by lowest miles?', null, ['PARTS_INQUIRY']],
    ['How much is a cabin air filter?', 'PARTS_INQUIRY', []],
    // service
    [
      'Does the price include a service contract?',
      null,
      ['SERVICE_APPOINTMENT'],
    ],
    ['I want to schedule service for my Wrangler', 'SERVICE_APPOINTMENT', []],
    // hold
    ['Hold on, let me check with my wife', null, ['HOLD_REQUEST']],
    ['Can you hold it until Saturday?', 'HOLD_REQUEST', []],
    // finance
    ['When is the finance office open?', 'HOURS_LOCATION', []],
    ['Can I apply for financing online?', 'CREDIT_APPLICATION', []],
    // appointment
    [
      'I need an appointment for an oil change',
      'SERVICE_APPOINTMENT',
      ['SALES_APPOINTMENT'],
    ],
  ];

  it.each(cases)('%s', (msg, expected, forbidden) => {
    const got = ids(msg, { hasVisibleVehicles: true });
    if (expected) expect(got).toContain(expected);
    for (const f of forbidden) expect(got).not.toContain(f);
  });

  it('bare "yes" is never captured as a first name', () => {
    expect(
      u('yes', { pending: 'contact_name' }).entities.contact,
    ).toBeUndefined();
    expect(
      u('Mike', { pending: 'contact_name' }).entities.contact?.firstName,
    ).toBe('Mike');
    expect(u('Mike', { pending: 'none' }).entities.contact).toBeUndefined();
  });

  it('VINs are not mistaken for phone numbers', () => {
    const r = u('VIN 1C4RJFBG0MC100001');
    expect(r.entities.vin).toBe('1C4RJFBG0MC100001');
    expect(r.entities.contact?.phone).toBeUndefined();
  });

  it('flags credit-sensitive data', () => {
    expect(u('my ssn is 123-45-6789').entities.sensitive).toContain('ssn');
    expect(u('card 4111 1111 1111 1111').entities.sensitive).toContain('card');
  });

  it('detects Spanish and payment phrasing', () => {
    const r = u(
      'Hola, busco una camioneta Tacoma, ¿cuánto sería al mes con 3 mil de enganche?',
    );
    expect(r.entities.language).toBe('es');
    expect(r.entities.downPayment).toBe(3000);
    expect(hasIntent(r, 'PAYMENT_ESTIMATE')).toBe(true);
  });

  it('price vs monthly payment are separated', () => {
    const r = u('Need an SUV under $40k and under $600 a month');
    expect(r.entities.maxPrice).toBe(40000);
    expect(r.entities.maxMonthly).toBe(600);
  });

  it('customer APR is only captured when explicitly stated', () => {
    expect(
      u('what would it be at 4.9% apr for 60 months').entities.customerApr,
    ).toBe(4.9);
    expect(u('am I approved?').entities.customerApr).toBeUndefined();
  });
});

describe('understandTurn — inventory filter criteria', () => {
  it('parses max price under $X (comma dollars and k suffix)', () => {
    expect(u('Any Jeep under $40,000?').entities.maxPrice).toBe(40000);
    expect(u('SUVs under 45k').entities).toMatchObject({
      maxPrice: 45000,
      vehicle: { bodyType: 'SUV' },
    });
    expect(u('my budget is 40k for an SUV').entities.maxPrice).toBe(40000);
  });

  it('parses color and model together with a price cap', () => {
    const r = u('Show me a red Grand Cherokee under 50k');
    expect(r.entities.maxPrice).toBe(50000);
    expect(r.entities.vehicle).toMatchObject({
      make: 'Jeep',
      model: 'Grand Cherokee',
      color: 'red',
    });
    expect(r.primary).toBe('INVENTORY_SEARCH');
  });

  it('parses body type SUV (and crossovers)', () => {
    expect(u('Do you have any SUVs in stock?').entities.vehicle?.bodyType).toBe(
      'SUV',
    );
    expect(
      u('Looking at crossovers under 35 grand').entities.vehicle,
    ).toMatchObject({
      bodyType: 'SUV',
    });
    expect(u('Need a third row for the family').entities.vehicle).toMatchObject(
      {
        bodyType: 'SUV',
        seatsMin: 7,
      },
    );
  });

  it('does not treat mileage caps as vehicle price', () => {
    const r = u('used SUV under 50k miles');
    expect(r.entities.maxPrice).toBeUndefined();
    expect(r.entities.vehicle?.maxMileage).toBe(50000);
  });
});
