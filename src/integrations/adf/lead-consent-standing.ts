import { normalizeEndpoint } from '../../messaging/consent.service';

/**
 * Customer consent standing for an ADF lead hand-off, resolved from the append-only consent
 * ledger (`ConsentRecord`) for the lead's own email / phone inside the lead's own tenant.
 *
 * THE RULE (see docs/ADF_LEAD_DELIVERY.md, "Consent"):
 *  - Handing a lead to the rooftop's own CRM is NOT a marketing send, so it does not require a
 *    marketing grant. It is refused (`no_consent_basis`) only when the customer may not be
 *    contacted at all:
 *      1. `Lead.optOutAt` is set, or the lead is marked spam (checked by the caller); or
 *      2. an explicit do-not-contact / all-channel opt-out is on the ledger for one of the
 *         lead's endpoints with no later grant on that endpoint; or
 *      3. every way the lead could be reached is opted out: the email (if any) has a standing
 *         EMAIL opt-out AND the phone (if any) has standing opt-outs for BOTH text and call.
 *  - An opt-out on ONE channel (e.g. a text STOP) does not block the hand-off while another
 *    contact channel remains, but it is reported truthfully: that channel is "false" in the ADF
 *    consent summary and is never reported as consent, whatever `Lead.consentTo*` says.
 *  - Per channel the LATEST non-revoked ledger record for (channel, endpoint) wins. With no
 *    ledger record the lead's own flag counts as a recorded opt-in; otherwise "not recorded".
 */
export type LedgerRow = {
  channel: string;
  endpoint: string;
  granted: boolean;
  createdAt: Date;
  evidence?: unknown;
};

/** true = recorded opt-in, false = recorded opt-out, null = not recorded. */
export type ChannelStanding = boolean | null;

export type LeadConsentStanding = {
  text: ChannelStanding;
  email: ChannelStanding;
  call: ChannelStanding;
  doNotContact: boolean;
  /** PII-free code for metrics / history. */
  reason:
    | 'ok'
    | 'lead_opted_out'
    | 'explicit_do_not_contact'
    | 'all_channels_opted_out';
};

export type StandingLead = {
  email: string | null;
  phone: string | null;
  consentToText: boolean;
  consentToEmail: boolean;
  consentToCall: boolean;
  optOutAt: Date | null;
};

/** Normalized ledger endpoints for a lead (what the ledger query must match). */
export function leadConsentEndpoints(lead: {
  email: string | null;
  phone: string | null;
}): { email: string | null; phone: string | null } {
  return {
    email: lead.email ? normalizeEndpoint('EMAIL', lead.email) : null,
    phone: lead.phone ? normalizeEndpoint('SMS', lead.phone) : null,
  };
}

/** An opt-out row that says "do not contact me at all", not just "not on this channel". */
export function isDoNotContactRow(r: LedgerRow): boolean {
  if (r.granted) return false;
  if (String(r.channel).toUpperCase() === 'ALL') return true;
  const e =
    r.evidence && typeof r.evidence === 'object'
      ? (r.evidence as Record<string, unknown>)
      : {};
  return (
    e.doNotContact === true ||
    (typeof e.scope === 'string' &&
      ['ALL', 'ALL_CHANNELS', 'DO_NOT_CONTACT'].includes(e.scope.toUpperCase()))
  );
}

export function resolveLeadConsentStanding(
  lead: StandingLead,
  rows: ReadonlyArray<LedgerRow>,
): LeadConsentStanding {
  const ep = leadConsentEndpoints(lead);
  const mine = rows
    .filter((r) => r.endpoint === ep.email || r.endpoint === ep.phone)
    .slice()
    // Newest first; on an exact timestamp tie the opt-out wins (fail closed).
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        Number(a.granted) - Number(b.granted),
    );
  const latest = (
    channel: string,
    endpoint: string | null,
  ): ChannelStanding => {
    if (!endpoint) return null;
    const r = mine.find(
      (x) => x.channel === channel && x.endpoint === endpoint,
    );
    return r ? r.granted : null;
  };
  const ledger = {
    text: latest('SMS', ep.phone),
    email: latest('EMAIL', ep.email),
    call: latest('CALL', ep.phone),
  };
  const flag = (granted: boolean): ChannelStanding => (granted ? true : null);

  if (lead.optOutAt !== null)
    return {
      text: false,
      email: false,
      call: false,
      doNotContact: true,
      reason: 'lead_opted_out',
    };

  const summary = {
    text: ledger.text ?? flag(lead.consentToText),
    email: ledger.email ?? flag(lead.consentToEmail),
    call: ledger.call ?? flag(lead.consentToCall),
  };

  // Explicit do-not-contact with no later grant on the same endpoint.
  const dnc = mine.find(isDoNotContactRow);
  if (
    dnc &&
    !mine.some(
      (r) =>
        r.granted &&
        r.endpoint === dnc.endpoint &&
        r.createdAt.getTime() > dnc.createdAt.getTime(),
    )
  )
    return {
      text: false,
      email: false,
      call: false,
      doNotContact: true,
      reason: 'explicit_do_not_contact',
    };

  const emailOut = ep.email ? ledger.email === false : true;
  const phoneOut = ep.phone
    ? ledger.text === false && ledger.call === false
    : true;
  if ((ep.email || ep.phone) && emailOut && phoneOut)
    return { ...summary, doNotContact: true, reason: 'all_channels_opted_out' };

  return { ...summary, doNotContact: false, reason: 'ok' };
}
