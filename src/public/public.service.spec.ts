import { NotFoundException } from '@nestjs/common';
import { PublicService } from './public.service';
import { DEFAULT_PUBLIC_BRANDING } from '../common/types/public-branding';

describe('PublicService widget-config public contract', () => {
  const tenantRow = {
    id: 'tenant-internal-id-123',
    name: 'Jeep of Chicago',
    slug: 'jeep-of-chicago',
    publicConfig: {},
    configVersion: 2,
    consentText:
      'Internal staging environment for authorized testing only. Do not enter real customer information.',
    locations: [
      {
        id: 'location-internal-id-456',
        name: 'Main',
        slug: 'main',
        phone: null,
        timezone: 'America/Chicago',
        publicConfig: {},
      },
    ],
  };

  const features = {
    chat: true,
    inventory: false,
    payments: false,
    leadCapture: true,
    handoff: true,
    serviceAi: false,
    partsAi: false,
    multilingual: false,
    voiceAi: false,
    proactiveEngagement: false,
  };

  function service(tenant: typeof tenantRow | null) {
    const prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue(tenant) },
    };
    const flags = { forWidget: jest.fn().mockResolvedValue(features) };
    const cache = {
      widgetConfigKey: jest.fn().mockReturnValue('widget-config:k'),
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
      invalidatePrefix: jest.fn().mockResolvedValue(undefined),
    };
    return new PublicService(prisma as never, flags as never, cache as never);
  }

  it('returns only the approved public keys at top level', async () => {
    const payload = await service(tenantRow).getWidgetConfig(
      'jeep-of-chicago',
      'main',
    );
    expect(Object.keys(payload).sort()).toEqual(
      [
        'ok',
        'configVersion',
        'tenant',
        'location',
        'branding',
        'features',
        'proactive',
        'locales',
        'consentText',
      ].sort(),
    );
  });

  it('tenant object exposes only name and slug — no internal id', async () => {
    const payload = await service(tenantRow).getWidgetConfig(
      'jeep-of-chicago',
      'main',
    );
    expect(payload.tenant).toEqual({
      name: 'Jeep of Chicago',
      slug: 'jeep-of-chicago',
    });
    expect(payload.tenant).not.toHaveProperty('id');
  });

  it('location object exposes only name, slug, timezone — no internal id', async () => {
    const payload = await service(tenantRow).getWidgetConfig(
      'jeep-of-chicago',
      'main',
    );
    expect(payload.location).toEqual({
      name: 'Main',
      slug: 'main',
      timezone: 'America/Chicago',
    });
    expect(payload.location).not.toHaveProperty('id');
  });

  it('serialized payload never contains internal database ids or private keys', async () => {
    const payload = await service(tenantRow).getWidgetConfig(
      'jeep-of-chicago',
      'main',
    );
    const raw = JSON.stringify(payload).toLowerCase();
    expect(raw).not.toContain('tenant-internal-id-123');
    expect(raw).not.toContain('location-internal-id-456');
    for (const forbidden of [
      'allowedorigins',
      'escalationrecipients',
      'inventoryfeedurl',
      'apikey',
      'jwt_secret',
      'password',
      'ciphertext',
      'integrationid',
      'databaseurl',
      '"id"',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('passes consent text through verbatim', async () => {
    const payload = await service(tenantRow).getWidgetConfig(
      'jeep-of-chicago',
      'main',
    );
    expect(payload.consentText).toBe(
      'Internal staging environment for authorized testing only. Do not enter real customer information.',
    );
  });

  it('default escalation wording never claims staff were notified', () => {
    const msg = DEFAULT_PUBLIC_BRANDING.escalationMessage;
    expect(msg).toBe('I can save your request for dealership staff to review.');
    expect(msg.toLowerCase()).not.toMatch(/notified|has been sent|contacted/);
  });

  it('default disclaimer commits to verified-only information', () => {
    expect(DEFAULT_PUBLIC_BRANDING.disclaimerText).toBe(
      'Vehicle availability, pricing, incentives, and dealership information are provided only when verified.',
    );
  });

  it('throws TENANT_NOT_FOUND for unknown tenant', async () => {
    await expect(
      service(null).getWidgetConfig('nope', 'main'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws LOCATION_NOT_FOUND for unknown location', async () => {
    await expect(
      service(tenantRow).getWidgetConfig('jeep-of-chicago', 'other'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
