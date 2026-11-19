import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChatDto } from './chat.dto';

async function errors(body: object): Promise<string[]> {
  const res = await validate(plainToInstance(ChatDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flat = (e: (typeof res)[number], path = ''): string[] => [
    ...Object.keys(e.constraints ?? {}).map((c) => `${path}${e.property}:${c}`),
    ...(e.children ?? []).flatMap((c) => flat(c, `${path}${e.property}.`)),
  ];
  return res.flatMap((e) => flat(e));
}

const lead = {
  formId: 'lf_abcdefghijklmnop',
  firstName: 'Pat',
  lastName: 'Rivera',
  email: 'pat.rivera@example.invalid',
  phone: '312-555-0142',
  preferredChannel: 'EMAIL',
  consents: [
    { channel: 'EMAIL', granted: true, version: 'lead-form-consent-v1' },
  ],
};
const picker = { pickerId: 'pk_abcdefghijklmnop' };

describe('ChatDto — structured additions', () => {
  it('existing requests are unchanged', async () => {
    expect(await errors({ message: 'hello' })).toEqual([]);
    expect(
      await errors({ action: 'test_drive', vin: '1C4HJXDG0RW100001' }),
    ).toEqual([]);
    expect(await errors({})).not.toEqual([]);
  });

  it('accepts a lead with lead_capture and a selection with appointment_select', async () => {
    expect(await errors({ action: 'lead_capture', lead })).toEqual([]);
    expect(
      await errors({
        action: 'appointment_select',
        appointment: { ...picker, slotId: 'sl_abcdefghijkl' },
      }),
    ).toEqual([]);
    expect(
      await errors({
        action: 'appointment_select',
        appointment: {
          ...picker,
          requestedDate: '2026-10-14',
          requestedWindow: 'morning',
        },
      }),
    ).toEqual([]);
  });

  it('rejects a payload sent with the wrong (or no) action', async () => {
    expect(await errors({ message: 'hi', lead })).toContain(
      'lead:onlyWithAction',
    );
    expect(await errors({ action: 'test_drive', lead })).toContain(
      'lead:onlyWithAction',
    );
    expect(
      await errors({ action: 'lead_capture', appointment: picker }),
    ).toContain('appointment:onlyWithAction');
    expect(await errors({ message: 'hi', appointment: picker })).toContain(
      'appointment:onlyWithAction',
    );
  });

  it.each([
    [{ ...lead, ssn: '000-00-0000' }, 'lead.ssn:whitelistValidation'],
    [{ ...lead, dob: '1990-01-01' }, 'lead.dob:whitelistValidation'],
    [{ ...lead, income: 90000 }, 'lead.income:whitelistValidation'],
    [{ ...lead, tenantId: 't' }, 'lead.tenantId:whitelistValidation'],
    [{ ...lead, firstName: 'x'.repeat(61) }, 'lead.firstName:isLength'],
    [{ ...lead, lastName: '' }, 'lead.lastName:isLength'],
    [{ ...lead, email: 'nope' }, 'lead.email:isEmail'],
    [{ ...lead, phone: '1'.repeat(25) }, 'lead.phone:isLength'],
    [{ ...lead, formId: 'not-a-form-id' }, 'lead.formId:matches'],
    [{ ...lead, preferredChannel: 'FAX' }, 'lead.preferredChannel:isIn'],
    [{ ...lead, consents: 'yes' }, 'lead.consents:isArray'],
    [
      {
        ...lead,
        consents: [{ channel: 'EMAIL', granted: 'yes', version: 'v' }],
      },
      'lead.consents.0.granted:isBoolean',
    ],
    [
      {
        ...lead,
        consents: [
          { channel: 'EMAIL', granted: true, version: 'v'.repeat(65) },
        ],
      },
      'lead.consents.0.version:isLength',
    ],
    [
      {
        ...lead,
        consents: [
          { channel: 'EMAIL', granted: true, version: 'v', note: 'x' },
        ],
      },
      'lead.consents.0.note:whitelistValidation',
    ],
    [
      {
        ...lead,
        consents: [
          { channel: 'EMAIL', granted: true, version: 'v' },
          { channel: 'EMAIL', granted: false, version: 'v' },
        ],
      },
      'lead.consents:arrayUnique',
    ],
  ])('rejects lead %#', async (bad, expected) => {
    expect(await errors({ action: 'lead_capture', lead: bad })).toContain(
      expected,
    );
  });

  it.each([
    [{ pickerId: 'x' }, 'appointment.pickerId:matches'],
    [{ ...picker, slotId: 'DROP TABLE' }, 'appointment.slotId:matches'],
    [
      { ...picker, requestedDate: '10/14/2026' },
      'appointment.requestedDate:matches',
    ],
    [
      { ...picker, requestedWindow: 'noon' },
      'appointment.requestedWindow:isIn',
    ],
    [
      { ...picker, locationId: 'loc' },
      'appointment.locationId:whitelistValidation',
    ],
    [
      { ...picker, startUtc: '2026-10-14T15:00:00Z' },
      'appointment.startUtc:whitelistValidation',
    ],
  ])('rejects appointment %#', async (bad, expected) => {
    expect(
      await errors({ action: 'appointment_select', appointment: bad }),
    ).toContain(expected);
  });

  it('a non-object payload is rejected', async () => {
    expect(await errors({ action: 'lead_capture', lead: 'x' })).not.toEqual([]);
    expect(
      await errors({ action: 'appointment_select', appointment: [] }),
    ).not.toEqual([]);
  });
});
