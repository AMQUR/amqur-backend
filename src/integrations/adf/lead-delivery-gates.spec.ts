import {
  checkDestinationForMode,
  departmentForLeadSource,
  effectiveMode,
  evaluateSendGates,
  GateInput,
  GateRoute,
  leadDeliveryIdempotencyKey,
  readLeadDeliveryEnv,
  ADF_FEATURE_FLAG,
  acknowledgementCountsForMode,
  blockReasonStillApplies,
  sandboxRefused,
  SEND_DEADLINE_DEFAULT_MS,
  SEND_DEADLINE_MAX_MS,
  SENT_STALE_MARGIN_MS,
  SENT_STALE_MS,
} from './lead-delivery-gates';
import { OUTBOX_LEASE_MS } from '../core/outbox.service';
import { envValidationSchema } from '../../config/env.validation';
import { PLATFORM_FEATURE_DEFAULTS } from '../../feature-flags/feature-flags.service';

const route = (over: Partial<GateRoute> = {}): GateRoute => ({
  id: 'route-1',
  tenantId: 'tenant-south',
  locationId: 'loc-south',
  environment: 'SANDBOX',
  enabled: true,
  verified: true,
  productionEnabled: false,
  ...over,
});
const input = (over: Partial<GateInput> = {}): GateInput => ({
  env: readLeadDeliveryEnv({ NODE_ENV: 'test', ADF_SEND_ENABLED: 'true' }),
  flagEnabled: true,
  lead: {
    tenantId: 'tenant-south',
    locationId: 'loc-south',
    hasContactMethod: true,
    optedOut: false,
    spam: false,
  },
  route: route(),
  ...over,
});
const liveEnv = readLeadDeliveryEnv({
  NODE_ENV: 'production',
  ADF_SEND_ENABLED: 'true',
  LEAD_DELIVERY_MODE: 'live',
  ADF_SMTP_HOST: 'smtp.relay.example.invalid',
});

describe('lead delivery gates (all fail-closed)', () => {
  it('defaults: sending off, sandbox mode, sink transport, loopback SMTP', () => {
    const env = readLeadDeliveryEnv({});
    expect(env).toMatchObject({
      sendEnabled: false,
      requestedMode: 'sandbox',
      sandboxTransport: 'sink',
      smtp: { host: '127.0.0.1', port: 11025, secure: false },
      fromAddress: 'adf-sandbox@amqur.example.invalid',
    });
    expect(effectiveMode(env)).toBe('sandbox');
    expect(evaluateSendGates(input({ env }))).toEqual({
      open: false,
      reason: 'send_disabled',
    });
    // Only the exact string 'true' turns sending on.
    for (const v of ['1', 'TRUE', 'yes', ''])
      expect(readLeadDeliveryEnv({ ADF_SEND_ENABLED: v }).sendEnabled).toBe(
        false,
      );
  });

  it('live needs production AND mode=live AND the master switch', () => {
    expect(effectiveMode(liveEnv)).toBe('live');
    for (const env of [
      { ...liveEnv, nodeEnv: 'development' },
      { ...liveEnv, nodeEnv: 'test' },
      { ...liveEnv, requestedMode: 'sandbox' as const },
      { ...liveEnv, sendEnabled: false },
    ])
      expect(effectiveMode(env)).toBe('sandbox');
    expect(
      readLeadDeliveryEnv({ LEAD_DELIVERY_MODE: 'LIVE' }).requestedMode,
    ).toBe('sandbox');
  });

  it('sandbox: open only with switch + flag + enabled verified route for the lead', () => {
    expect(evaluateSendGates(input())).toEqual({
      open: true,
      mode: 'sandbox',
      transport: 'sink',
    });
    const closed: Array<[Partial<GateInput>, string]> = [
      [{ flagEnabled: false }, 'flag_off'],
      [{ route: null }, 'no_route'],
      [{ route: route({ enabled: false }) }, 'route_disabled'],
      [{ route: route({ verified: false }) }, 'route_unverified'],
      [
        { lead: { ...input().lead, hasContactMethod: false } },
        'no_contact_method',
      ],
      [{ lead: { ...input().lead, optedOut: true } }, 'no_consent_basis'],
      [{ lead: { ...input().lead, spam: true } }, 'no_consent_basis'],
      [{ lead: { ...input().lead, locationId: null } }, 'no_location'],
    ];
    for (const [over, reason] of closed)
      expect(evaluateSendGates(input(over))).toEqual({ open: false, reason });
  });

  it('a route from another tenant or rooftop is refused even if handed in', () => {
    expect(
      evaluateSendGates(input({ route: route({ tenantId: 'tenant-north' }) })),
    ).toEqual({ open: false, reason: 'route_tenant_mismatch' });
    expect(
      evaluateSendGates(input({ route: route({ locationId: 'loc-north' }) })),
    ).toEqual({ open: false, reason: 'route_tenant_mismatch' });
  });

  it('a production route is still forced to the sandbox transport outside live mode', () => {
    const prod = route({ environment: 'PRODUCTION', productionEnabled: true });
    expect(evaluateSendGates(input({ route: prod }))).toEqual({
      open: true,
      mode: 'sandbox',
      transport: 'sink',
    });
    const smtpEnv = readLeadDeliveryEnv({
      NODE_ENV: 'production', // production but mode not live
      ADF_SEND_ENABLED: 'true',
      ADF_SANDBOX_TRANSPORT: 'smtp',
    });
    // R3: production never falls back to a sandbox transport — it is refused outright.
    expect(evaluateSendGates(input({ env: smtpEnv, route: prod }))).toEqual({
      open: false,
      reason: 'sandbox_in_production',
    });
  });

  it('R9: the send deadline is bounded and the stale-SENT window always exceeds it by the margin', () => {
    expect(readLeadDeliveryEnv({}).sendDeadlineMs).toBe(
      SEND_DEADLINE_DEFAULT_MS,
    );
    expect(
      readLeadDeliveryEnv({ ADF_SEND_DEADLINE_MS: '500' }).sendDeadlineMs,
    ).toBe(500);
    // Out-of-range or junk values fall back to the default — never to "no deadline".
    for (const v of ['0', '-1', '600000', 'abc', '1.5'])
      expect(
        readLeadDeliveryEnv({ ADF_SEND_DEADLINE_MS: v }).sendDeadlineMs,
      ).toBe(SEND_DEADLINE_DEFAULT_MS);
    expect(SEND_DEADLINE_DEFAULT_MS).toBeLessThanOrEqual(SEND_DEADLINE_MAX_MS);
    expect(SENT_STALE_MS).toBeGreaterThanOrEqual(
      SEND_DEADLINE_MAX_MS + SENT_STALE_MARGIN_MS,
    );
    expect(SENT_STALE_MARGIN_MS).toBeGreaterThanOrEqual(30_000);
    // The outbox lease is longer than the stale window, so a lease can never hide a stale row.
    expect(OUTBOX_LEASE_MS).toBeGreaterThan(SENT_STALE_MS);
    const { error, value } = envValidationSchema.validate(
      { ADF_SEND_DEADLINE_MS: '90000' },
      { allowUnknown: true, abortEarly: false },
    );
    expect(String(error ?? '')).toContain('ADF_SEND_DEADLINE_MS');
    expect(value).toBeDefined();
  });

  it('R3: production + master switch on + mode not live ⇒ sandbox_in_production (sink and smtp)', () => {
    for (const ADF_SANDBOX_TRANSPORT of ['sink', 'smtp', undefined]) {
      const env = readLeadDeliveryEnv({
        NODE_ENV: 'production',
        ADF_SEND_ENABLED: 'true',
        ADF_SANDBOX_TRANSPORT,
      });
      expect(sandboxRefused(env)).toBe(true);
      expect(evaluateSendGates(input({ env }))).toEqual({
        open: false,
        reason: 'sandbox_in_production',
      });
      expect(blockReasonStillApplies('sandbox_in_production', env)).toBe(true);
    }
    expect(sandboxRefused(liveEnv)).toBe(false);
    expect(blockReasonStillApplies('sandbox_in_production', liveEnv)).toBe(
      false,
    );
    // Outside production the sandbox is the normal, allowed path.
    expect(sandboxRefused(input().env)).toBe(false);
    expect(blockReasonStillApplies('send_disabled', input().env)).toBe(false);
    expect(
      blockReasonStillApplies('send_disabled', readLeadDeliveryEnv({})),
    ).toBe(true);
    expect(blockReasonStillApplies('route_unverified', liveEnv)).toBe(true);
  });

  it('R3: a sandbox acknowledgement never counts as acknowledged once the environment is live', () => {
    expect(acknowledgementCountsForMode('sandbox', input().env)).toBe(true);
    expect(acknowledgementCountsForMode(null, input().env)).toBe(true);
    expect(acknowledgementCountsForMode('sandbox', liveEnv)).toBe(false);
    expect(acknowledgementCountsForMode(null, liveEnv)).toBe(false);
    expect(acknowledgementCountsForMode('live', liveEnv)).toBe(true);
  });

  it('live: additionally needs a PRODUCTION, production-enabled route', () => {
    const env = liveEnv;
    expect(
      evaluateSendGates(
        input({
          env,
          route: route({ environment: 'PRODUCTION', productionEnabled: true }),
        }),
      ),
    ).toEqual({ open: true, mode: 'live', transport: 'smtp' });
    expect(
      evaluateSendGates(
        input({ env, route: route({ environment: 'PRODUCTION' }) }),
      ),
    ).toEqual({ open: false, reason: 'route_not_production_enabled' });
    expect(evaluateSendGates(input({ env, route: route() }))).toEqual({
      open: false,
      reason: 'route_not_production_environment',
    });
    expect(
      evaluateSendGates(
        input({
          env,
          route: route({
            environment: 'PRODUCTION',
            productionEnabled: true,
            verified: false,
          }),
        }),
      ),
    ).toEqual({ open: false, reason: 'route_unverified' });
  });

  it('destination check: sandbox SMTP needs loopback + a reserved recipient; live refuses reserved', () => {
    const d = (
      mode: 'sandbox' | 'live',
      transport: 'sink' | 'smtp',
      destination: string,
      smtpHost = '127.0.0.1',
    ) => checkDestinationForMode({ mode, transport, destination, smtpHost });
    expect(d('sandbox', 'sink', 'leads@dealer-crm.net')).toEqual({ ok: true });
    expect(d('sandbox', 'smtp', 'adf@leads.example.invalid')).toEqual({
      ok: true,
    });
    expect(d('sandbox', 'smtp', 'leads@dealer-crm.net')).toEqual({
      ok: false,
      reason: 'sandbox_recipient_not_reserved',
    });
    expect(
      d('sandbox', 'smtp', 'adf@leads.example.invalid', 'smtp.sendgrid.net'),
    ).toEqual({ ok: false, reason: 'smtp_host_not_loopback' });
    expect(
      d('live', 'smtp', 'adf@leads.example.invalid', 'relay.host'),
    ).toEqual({
      ok: false,
      reason: 'reserved_destination_in_live',
    });
    expect(d('live', 'smtp', 'leads@dealer-crm.net', 'relay.host')).toEqual({
      ok: true,
    });
  });

  it('platform flag and validated env defaults are off / sandbox', () => {
    expect(ADF_FEATURE_FLAG).toBe('adfLeadDelivery');
    expect(PLATFORM_FEATURE_DEFAULTS[ADF_FEATURE_FLAG]).toBe(false);
    const base = {
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
      JWT_SECRET: 'x'.repeat(40),
    };
    const { value, error } = envValidationSchema.validate(base, {
      allowUnknown: true,
    });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      ADF_SEND_ENABLED: 'false',
      LEAD_DELIVERY_MODE: 'sandbox',
      ADF_SANDBOX_TRANSPORT: 'sink',
      ADF_SMTP_HOST: '127.0.0.1',
      ADF_FROM_ADDRESS: 'adf-sandbox@amqur.example.invalid',
    });
    // Asking for live without a relay host / sender is a configuration error, not a default.
    expect(
      envValidationSchema.validate(
        { ...base, LEAD_DELIVERY_MODE: 'live' },
        { allowUnknown: true },
      ).error?.message,
    ).toMatch(/ADF_SMTP_HOST|ADF_FROM_ADDRESS/);
    for (const bad of [
      { ADF_SEND_ENABLED: 'yes' },
      { LEAD_DELIVERY_MODE: 'prod' },
      { ADF_SANDBOX_TRANSPORT: 'sendgrid' },
    ])
      expect(
        envValidationSchema.validate(
          { ...base, ...bad },
          { allowUnknown: true },
        ).error,
      ).toBeDefined();
  });

  it('department and idempotency key are deterministic', () => {
    expect(departmentForLeadSource('widget')).toBe('SALES');
    expect(departmentForLeadSource('widget_service')).toBe('SERVICE');
    expect(departmentForLeadSource('widget_parts')).toBe('PARTS');
    expect(departmentForLeadSource(null)).toBe('SALES');
    const k = (over = {}) =>
      leadDeliveryIdempotencyKey({
        leadId: 'lead-1',
        channel: 'ADF_EMAIL',
        locationId: 'loc-south',
        department: 'SALES',
        ...over,
      });
    expect(k()).toBe(k());
    expect(k()).toBe('lead-delivery:v1:lead-1:ADF_EMAIL:loc-south:SALES');
    expect(k({ locationId: 'loc-north' })).not.toBe(k());
    expect(k({ department: 'SERVICE' })).not.toBe(k());
    expect(k({ leadId: 'lead-2' })).not.toBe(k());
  });
});
