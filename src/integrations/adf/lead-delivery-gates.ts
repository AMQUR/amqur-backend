import { ADF_DEFAULT_MAX_BYTES } from './adf.types';
import {
  destinationDomain,
  isLoopbackHost,
  isReservedTestDomain,
} from './destination';

export type LeadDeliveryEnv = {
  nodeEnv: string;
  /** ADF_SEND_ENABLED === 'true' — master switch, default off. */
  sendEnabled: boolean;
  /** LEAD_DELIVERY_MODE — anything other than exactly 'live' is sandbox. */
  requestedMode: 'sandbox' | 'live';
  sandboxTransport: 'sink' | 'smtp';
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string | null;
    pass: string | null;
  };
  fromAddress: string;
  providerName: string;
  maxBytes: number;
  sinkDir: string | null;
  /** Hard overall deadline for ONE transport hand-off (ADF_SEND_DEADLINE_MS). */
  sendDeadlineMs: number;
};

/**
 * One hard, overall deadline per send — connect + greeting + TLS + auth + DATA together — and
 * the window after which a SENT row with no outcome is treated as a crashed attempt.
 * INVARIANT: SENT_STALE_MS >= SEND_DEADLINE_MAX_MS + SENT_STALE_MARGIN_MS, so a row can never
 * be reclaimed (and re-sent) while its own send is still inside its deadline.
 */
export const SEND_DEADLINE_DEFAULT_MS = 30_000;
export const SEND_DEADLINE_MIN_MS = 250;
export const SEND_DEADLINE_MAX_MS = 60_000;
export const SENT_STALE_MARGIN_MS = 30_000;
export const SENT_STALE_MS = SEND_DEADLINE_MAX_MS + SENT_STALE_MARGIN_MS;

export const ADF_FEATURE_FLAG = 'adfLeadDelivery';
export const ADF_SANDBOX_FROM = 'adf-sandbox@amqur.example.invalid';

export function readLeadDeliveryEnv(
  env: Record<string, string | undefined> = process.env,
): LeadDeliveryEnv {
  const num = (v: string | undefined, d: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : d;
  };
  const str = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    sendEnabled: env.ADF_SEND_ENABLED === 'true',
    requestedMode: env.LEAD_DELIVERY_MODE === 'live' ? 'live' : 'sandbox',
    sandboxTransport: env.ADF_SANDBOX_TRANSPORT === 'smtp' ? 'smtp' : 'sink',
    smtp: {
      host: str(env.ADF_SMTP_HOST) ?? '127.0.0.1',
      port: num(env.ADF_SMTP_PORT, 11025, 1, 65535),
      secure: env.ADF_SMTP_SECURE === 'true',
      user: str(env.ADF_SMTP_USER),
      pass: str(env.ADF_SMTP_PASS),
    },
    fromAddress: str(env.ADF_FROM_ADDRESS) ?? ADF_SANDBOX_FROM,
    providerName: str(env.ADF_PROVIDER_NAME) ?? 'AMQUR AI',
    maxBytes: num(env.ADF_MAX_BYTES, ADF_DEFAULT_MAX_BYTES, 1024, 1024 * 1024),
    sinkDir: str(env.ADF_SANDBOX_SINK_DIR),
    sendDeadlineMs: num(
      env.ADF_SEND_DEADLINE_MS,
      SEND_DEADLINE_DEFAULT_MS,
      SEND_DEADLINE_MIN_MS,
      SEND_DEADLINE_MAX_MS,
    ),
  };
}

/**
 * Live is reachable ONLY when every environment-level switch agrees. Anything else — a
 * non-production NODE_ENV, a missing/other LEAD_DELIVERY_MODE, the master switch off — is
 * sandbox, no matter what a route says. In production the sandbox itself is refused
 * (`sandbox_in_production`): production either sends live or sends nothing.
 */
export function effectiveMode(env: LeadDeliveryEnv): 'sandbox' | 'live' {
  return env.nodeEnv === 'production' &&
    env.requestedMode === 'live' &&
    env.sendEnabled
    ? 'live'
    : 'sandbox';
}

export type GateRoute = {
  id: string;
  tenantId: string;
  locationId: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  enabled: boolean;
  verified: boolean;
  productionEnabled: boolean;
};

export type GateInput = {
  env: LeadDeliveryEnv;
  /** Tenant/location feature flag `adfLeadDelivery` (default false). */
  flagEnabled: boolean;
  lead: {
    tenantId: string;
    locationId: string | null;
    hasContactMethod: boolean;
    optedOut: boolean;
    spam: boolean;
  };
  /** The route looked up by the LEAD's tenant + location + department, or null. */
  route: GateRoute | null;
};

export type BlockReason =
  | 'send_disabled'
  | 'flag_off'
  | 'no_consent_basis'
  | 'no_contact_method'
  | 'no_location'
  | 'lead_location_changed'
  | 'no_route'
  | 'route_tenant_mismatch'
  | 'route_disabled'
  | 'route_unverified'
  | 'route_not_production_enabled'
  | 'route_not_production_environment'
  | 'sandbox_in_production';

export type GateDecision =
  | { open: true; mode: 'sandbox' | 'live'; transport: 'sink' | 'smtp' }
  | { open: false; reason: BlockReason };

/** Every gate is fail-closed; the first closed gate names the operator-visible reason. */
export function evaluateSendGates(i: GateInput): GateDecision {
  if (!i.env.sendEnabled) return { open: false, reason: 'send_disabled' };
  if (i.flagEnabled !== true) return { open: false, reason: 'flag_off' };
  if (i.lead.optedOut || i.lead.spam)
    return { open: false, reason: 'no_consent_basis' };
  if (!i.lead.hasContactMethod)
    return { open: false, reason: 'no_contact_method' };
  if (!i.lead.locationId) return { open: false, reason: 'no_location' };
  const r = i.route;
  if (!r) return { open: false, reason: 'no_route' };
  if (r.tenantId !== i.lead.tenantId || r.locationId !== i.lead.locationId)
    return { open: false, reason: 'route_tenant_mismatch' };
  if (r.enabled !== true) return { open: false, reason: 'route_disabled' };
  if (r.verified !== true) return { open: false, reason: 'route_unverified' };
  const mode = effectiveMode(i.env);
  if (mode === 'live') {
    if (r.environment !== 'PRODUCTION')
      return { open: false, reason: 'route_not_production_environment' };
    if (r.productionEnabled !== true)
      return { open: false, reason: 'route_not_production_enabled' };
    return { open: true, mode, transport: 'smtp' };
  }
  // Production never uses a sandbox transport: a real lead "accepted" by the sink would look
  // delivered and would never be sent once live is switched on.
  if (sandboxRefused(i.env))
    return { open: false, reason: 'sandbox_in_production' };
  return { open: true, mode, transport: i.env.sandboxTransport };
}

/** True when the process is production but live mode is not fully gated on. */
export function sandboxRefused(env: LeadDeliveryEnv): boolean {
  return env.nodeEnv === 'production' && effectiveMode(env) !== 'live';
}

/**
 * Block reasons that come from the ENVIRONMENT, not from the lead or its route. Rows blocked
 * for one of these are re-queued automatically once the environment no longer blocks them.
 */
export const REEVALUABLE_BLOCK_REASONS = [
  'sandbox_in_production',
  'send_disabled',
] as const;

export function blockReasonStillApplies(
  reason: string,
  env: LeadDeliveryEnv,
): boolean {
  if (reason === 'send_disabled') return !env.sendEnabled;
  if (reason === 'sandbox_in_production')
    return !env.sendEnabled || sandboxRefused(env);
  return true;
}

/**
 * Does an acknowledged row count as acknowledged in the CURRENT mode? A sandbox (or unrecorded)
 * acknowledgement never does once the environment is live.
 */
export function acknowledgementCountsForMode(
  deliveryMode: string | null | undefined,
  env: LeadDeliveryEnv,
): boolean {
  return effectiveMode(env) !== 'live' || deliveryMode === 'live';
}

export type DestinationBlockReason =
  | 'reserved_destination_in_live'
  | 'sandbox_recipient_not_reserved'
  | 'smtp_host_not_loopback';

/**
 * Last check before a transport is handed a recipient.
 *  - live: a reserved test domain is never a real CRM inbox;
 *  - sandbox SMTP: the host must be loopback AND the recipient a reserved test domain, so even a
 *    relaying MTA on localhost cannot reach a real mailbox;
 *  - sandbox sink: nothing leaves the process.
 */
export function checkDestinationForMode(p: {
  mode: 'sandbox' | 'live';
  transport: 'sink' | 'smtp';
  destination: string;
  smtpHost: string;
}): { ok: true } | { ok: false; reason: DestinationBlockReason } {
  const reserved = isReservedTestDomain(destinationDomain(p.destination));
  if (p.mode === 'live')
    return reserved
      ? { ok: false, reason: 'reserved_destination_in_live' }
      : { ok: true };
  if (p.transport === 'smtp') {
    if (!isLoopbackHost(p.smtpHost))
      return { ok: false, reason: 'smtp_host_not_loopback' };
    if (!reserved)
      return { ok: false, reason: 'sandbox_recipient_not_reserved' };
  }
  return { ok: true };
}

/** Consent basis for handing a lead to the rooftop's own CRM (never a marketing consent). */
export function departmentForLeadSource(
  source: string | null | undefined,
): 'SALES' | 'SERVICE' | 'PARTS' {
  if (source === 'widget_service') return 'SERVICE';
  if (source === 'widget_parts') return 'PARTS';
  return 'SALES';
}

export function leadDeliveryIdempotencyKey(p: {
  leadId: string;
  channel: string;
  locationId: string | null;
  department: string;
}): string {
  // (location, channel, department) is the route's natural key within the tenant, and the key is
  // unique per tenant — so this is deterministic per (tenant, lead, channel, route).
  return `lead-delivery:v1:${p.leadId}:${p.channel}:${p.locationId ?? 'no-location'}:${p.department}`;
}
