import {
  Channel,
  MessagePurpose,
  WORKFLOW_DIRECTION,
  WORKFLOW_PURPOSE,
  WorkflowKey,
} from '../crm-workforce.types';
import { EffectiveControl } from './controls';

/**
 * Mandatory communication policy — enforced OUTSIDE the language model.
 *
 * Pure function: the caller gathers facts (consent ledger, suppression list, attempts, hours,
 * ownership) and this decides. Every rule that fails is reported, not just the first, so staff
 * can see exactly why a record is not contactable. Anything unknown fails closed.
 *
 * Production policy values (caps, windows, wording) need qualified legal/compliance approval;
 * `policy.legalApproval` records it and external sending is blocked without it.
 */
export type CompliancePolicy = {
  version: string;
  /** Local contact window in the customer's timezone, minutes from midnight. */
  contactWindow: { startMin: number; endMin: number };
  maxPerDay: Record<MessagePurpose, number>;
  maxPerWeek: Record<MessagePurpose, number>;
  /** Unanswered outbound attempts after which automated outreach stops. */
  maxUnansweredAttempts: number;
  /** A consent grant older than this is not treated as current for MARKETING. */
  marketingConsentMaxAgeDays: number;
  /** Lead sources whose terms forbid automated follow-up (lowercased). */
  restrictedLeadSources: string[];
  /** Counsel sign-off for the policy actually used in production. */
  legalApproval: {
    approvedBy: string;
    approvedAt: string;
    documentRef: string;
  } | null;
};

export const DEFAULT_POLICY: CompliancePolicy = {
  version: 'crmwf-policy-1-unapproved',
  contactWindow: { startMin: 9 * 60, endMin: 20 * 60 },
  maxPerDay: { TRANSACTIONAL: 3, CONVERSATIONAL: 2, MARKETING: 1 },
  maxPerWeek: { TRANSACTIONAL: 6, CONVERSATIONAL: 4, MARKETING: 1 },
  maxUnansweredAttempts: 3,
  marketingConsentMaxAgeDays: 540,
  restrictedLeadSources: [],
  legalApproval: null,
};

const PURPOSES: MessagePurpose[] = [
  'TRANSACTIONAL',
  'CONVERSATIONAL',
  'MARKETING',
];
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
    ? v
    : null;

/**
 * Build a policy from untrusted stored/submitted JSON. Every field is validated and bounded;
 * anything missing or invalid falls back to the default for THAT field (never to "no limit").
 * `legalApproval` is taken only from the `legalApproval` argument — never from `raw` — so the
 * caller decides who is allowed to attest it.
 */
export function sanitizePolicy(
  raw: unknown,
  legalApproval: CompliancePolicy['legalApproval'] = null,
): CompliancePolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const cw = (
    r.contactWindow && typeof r.contactWindow === 'object'
      ? r.contactWindow
      : {}
  ) as Record<string, unknown>;
  const startMin = int(cw.startMin, 0, 1439);
  const endMin = int(cw.endMin, 1, 1440);
  const window =
    startMin !== null && endMin !== null && startMin < endMin
      ? { startMin, endMin }
      : DEFAULT_POLICY.contactWindow;
  const caps = (key: 'maxPerDay' | 'maxPerWeek', hi: number) => {
    const src = (r[key] && typeof r[key] === 'object' ? r[key] : {}) as Record<
      string,
      unknown
    >;
    const out = { ...DEFAULT_POLICY[key] };
    for (const p of PURPOSES)
      out[p] = int(src[p], 0, hi) ?? DEFAULT_POLICY[key][p];
    return out;
  };
  const sources = Array.isArray(r.restrictedLeadSources)
    ? r.restrictedLeadSources
        .filter((x): x is string => typeof x === 'string' && x.length <= 80)
        .slice(0, 100)
        .map((x) => x.trim().toLowerCase())
    : DEFAULT_POLICY.restrictedLeadSources;
  const la = legalApproval;
  const okApproval =
    !!la &&
    [la.approvedBy, la.approvedAt, la.documentRef].every(
      (x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 200,
    );
  return {
    version:
      typeof r.version === 'string' && /^[\w.:-]{1,60}$/.test(r.version)
        ? r.version
        : DEFAULT_POLICY.version,
    contactWindow: window,
    maxPerDay: caps('maxPerDay', 10),
    maxPerWeek: caps('maxPerWeek', 30),
    maxUnansweredAttempts:
      int(r.maxUnansweredAttempts, 1, 10) ??
      DEFAULT_POLICY.maxUnansweredAttempts,
    marketingConsentMaxAgeDays:
      int(r.marketingConsentMaxAgeDays, 1, 1825) ??
      DEFAULT_POLICY.marketingConsentMaxAgeDays,
    restrictedLeadSources: sources,
    legalApproval: okApproval
      ? {
          approvedBy: la!.approvedBy.trim(),
          approvedAt: la!.approvedAt.trim(),
          documentRef: la!.documentRef.trim(),
        }
      : null,
  };
}

export type ConsentFact =
  | {
      allowed: true;
      grantId: string;
      grantedAt: string;
      purpose: MessagePurpose;
    }
  | { allowed: false; reason: 'opted_out' | 'no_consent' | 'invalid_endpoint' };

export type ComplianceInput = {
  now: Date;
  workflowKey: WorkflowKey;
  channel: Channel;
  /** Normalized endpoint, or null when the lead has none for this channel. */
  endpoint: string | null;
  control: EffectiveControl;
  policy: CompliancePolicy;
  /** From the append-only consent ledger. A CRM flag or an old record is NOT consent. */
  consent: ConsentFact;
  /** Active suppressions for any of the customer's endpoints: channel or ALL. */
  suppressions: Array<{ channel: string; reason: string }>;
  /** CRM communication preference, when the adapter can read it. */
  crmDoNotContact: boolean | null;
  /** IANA timezone of the customer when known, else the dealership's. */
  timezone: string;
  timezoneSource: 'customer' | 'dealership';
  sentToday: number;
  sentThisWeek: number;
  unansweredAttempts: number;
  /** Customer's last inbound message; an inbound reply workflow needs one. */
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  humanOwnsConversation: boolean;
  leadPaused: boolean;
  /** Another open draft / queued send exists for this lead. */
  conflictingOpenAction: boolean;
  leadSource: string | null;
  /** Sender identity registered and approved for this rooftop + channel. */
  senderIdentityApproved: boolean;
  /** Adapter can execute this channel externally (verified capability). */
  channelCapabilityVerified: boolean;
};

export type ComplianceBlock = { rule: string; detail?: string };

export type ComplianceDecision = {
  policyVersion: string;
  evaluatedAt: string;
  purpose: MessagePurpose;
  direction: 'INBOUND_REPLY' | 'OUTBOUND';
  /** May a DRAFT be prepared for a person to review? (No customer contact happens.) */
  draftAllowed: boolean;
  /** May this be SENT to the customer by the system? */
  sendAllowed: boolean;
  blocks: ComplianceBlock[];
  /** Earliest instant the contact window reopens, when that is the only timing block. */
  deferUntil: string | null;
  /** True when the record needs a person to review consent instead of automated outreach. */
  routeForReview: boolean;
};

/** Rules that also forbid preparing a draft: the customer must not be contacted at all. */
const HARD_RULES = new Set([
  'suppressed',
  'opted_out',
  'crm_do_not_contact',
  'human_owns_conversation',
  'lead_paused',
  'halted',
  'no_endpoint',
  'invalid_endpoint',
]);

export function evaluateCompliance(i: ComplianceInput): ComplianceDecision {
  const purpose = WORKFLOW_PURPOSE[i.workflowKey];
  const direction = WORKFLOW_DIRECTION[i.workflowKey];
  const blocks: ComplianceBlock[] = [];
  const add = (rule: string, detail?: string) => blocks.push({ rule, detail });

  // 1. Emergency controls first — independent of everything else.
  if (i.control.halted) add('halted', i.control.haltedBy.join(','));
  for (const b of i.control.externalSendBlocks)
    if (b !== 'halted') add('control', b);

  // 2. The customer said stop. Never route around it on another channel.
  const sup = i.suppressions.filter(
    (s) => s.channel === 'ALL' || s.channel === i.channel,
  );
  if (sup.length) add('suppressed', sup.map((s) => s.reason).join(','));
  if (i.crmDoNotContact === true) add('crm_do_not_contact');

  // 3. Endpoint + channel-specific consent.
  if (!i.endpoint) add('no_endpoint');
  if (!i.consent.allowed) {
    add(i.consent.reason === 'opted_out' ? 'opted_out' : i.consent.reason);
  } else if (purpose === 'MARKETING') {
    if (i.consent.purpose !== 'MARKETING')
      add('consent_purpose_mismatch', i.consent.purpose);
    const ageDays =
      (i.now.getTime() - new Date(i.consent.grantedAt).getTime()) / 86_400_000;
    if (ageDays > i.policy.marketingConsentMaxAgeDays)
      add('consent_stale', `${Math.floor(ageDays)}d`);
  }

  // 4. People first: a human owner or a paused lead ends autonomous work.
  if (i.humanOwnsConversation) add('human_owns_conversation');
  if (i.leadPaused) add('lead_paused');
  if (i.conflictingOpenAction) add('conflicting_open_action');

  // 5. Direction. An inbound-reply workflow needs an unanswered inbound message; an inbound
  //    message never authorizes an unrelated promotional campaign.
  const awaitingReply =
    !!i.lastInboundAt &&
    (!i.lastOutboundAt || i.lastInboundAt > i.lastOutboundAt);
  if (direction === 'INBOUND_REPLY' && !awaitingReply)
    add('no_unanswered_inbound');

  // 6. Frequency and prior attempts (outbound only — a reply to the customer is not capped out).
  if (direction === 'OUTBOUND') {
    if (i.sentToday >= i.policy.maxPerDay[purpose])
      add('frequency_day', String(i.sentToday));
    if (i.sentThisWeek >= i.policy.maxPerWeek[purpose])
      add('frequency_week', String(i.sentThisWeek));
    if (i.unansweredAttempts >= i.policy.maxUnansweredAttempts)
      add('max_unanswered_attempts', String(i.unansweredAttempts));
    const src = (i.leadSource ?? '').trim().toLowerCase();
    if (src && i.policy.restrictedLeadSources.includes(src))
      add('lead_source_restricted', src);
  }

  // 7. Contact hours in the customer's timezone. Outbound only; replying to a customer who
  //    just wrote is permitted handling of their own conversation.
  let deferUntil: string | null = null;
  if (direction === 'OUTBOUND') {
    const mins = localMinutes(i.now, i.timezone);
    if (mins === null) add('timezone_unknown', i.timezone);
    else if (
      mins < i.policy.contactWindow.startMin ||
      mins >= i.policy.contactWindow.endMin
    ) {
      add('outside_contact_window', `${i.timezone}(${i.timezoneSource})`);
      deferUntil = nextWindowOpen(
        i.now,
        i.timezone,
        i.policy.contactWindow.startMin,
      );
    }
  }

  // 8. Sender identity, verified capability and counsel-approved policy for real sends.
  if (!i.senderIdentityApproved) add('sender_identity_not_approved');
  if (!i.channelCapabilityVerified) add('channel_capability_not_verified');
  if (!i.policy.legalApproval)
    add('policy_not_legally_approved', i.policy.version);

  const hard = blocks.some((b) => HARD_RULES.has(b.rule));
  // Outside-hours and frequency blocks stop a send; a draft for staff is still useful unless a
  // hard rule or a missing/absent consent says the customer should not be contacted.
  const consentMissing = blocks.some((b) =>
    ['no_consent', 'consent_purpose_mismatch', 'consent_stale'].includes(
      b.rule,
    ),
  );
  const draftAllowed =
    !hard &&
    !blocks.some((b) => b.rule === 'no_unanswered_inbound') &&
    // Without consent, only a reply to the customer's own inbound message may be drafted.
    (!consentMissing || direction === 'INBOUND_REPLY') &&
    !blocks.some((b) =>
      [
        'max_unanswered_attempts',
        'lead_source_restricted',
        'conflicting_open_action',
      ].includes(b.rule),
    );

  return {
    policyVersion: i.policy.version,
    evaluatedAt: i.now.toISOString(),
    purpose,
    direction,
    draftAllowed,
    sendAllowed: blocks.length === 0,
    blocks,
    deferUntil,
    routeForReview: consentMissing && direction === 'OUTBOUND',
  };
}

export function localMinutes(now: Date, tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  } catch {
    return null;
  }
}

/** Next instant (UTC ISO) at which the local clock in `tz` reads `startMin`. Minute-accurate. */
export function nextWindowOpen(
  now: Date,
  tz: string,
  startMin: number,
): string | null {
  const cur = localMinutes(now, tz);
  if (cur === null) return null;
  const delta = cur < startMin ? startMin - cur : 24 * 60 - cur + startMin;
  const t = new Date(now.getTime() + delta * 60_000);
  t.setUTCSeconds(0, 0);
  return t.toISOString();
}

/** US area code → IANA timezone for the handful of zones a dealership customer is usually in.
 *  Unknown codes return null and the dealership timezone is used (and labelled as such). */
const AREA_TZ: Record<string, string> = {};
const zone = (tz: string, codes: string) =>
  codes.split(' ').forEach((c) => (AREA_TZ[c] = tz));
zone(
  'America/Chicago',
  '312 773 872 708 630 331 847 224 815 779 618 217 309 262 414 608 920 715 314 636 816 612 651 713 281 832 214 972 469 512 210 504 615 901 205 402 405 918',
);
zone(
  'America/New_York',
  '212 646 718 917 347 516 631 914 201 973 609 215 267 412 617 508 202 703 571 301 240 404 678 770 305 786 954 407 813 904 313 248 586 734 216 614 513 317 219 574 260 704 919 502 804 757',
);
zone('America/Denver', '303 720 719 970 801 385 505 406 307 208');
zone('America/Phoenix', '602 480 623 520 928');
zone(
  'America/Los_Angeles',
  '213 310 323 424 818 626 562 714 949 619 858 415 510 408 916 209 559 702 725 503 971 206 253 425 509',
);

export function timezoneForPhone(e164: string | null): string | null {
  if (!e164) return null;
  const m = /^\+1(\d{3})\d{7}$/.exec(e164);
  return m ? (AREA_TZ[m[1]] ?? null) : null;
}
