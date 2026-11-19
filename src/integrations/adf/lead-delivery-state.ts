/**
 * Lead-delivery status ladder. ONE pure function decides every transition; a state is only
 * reachable with the evidence that proves it. See docs/ADF_LEAD_DELIVERY.md.
 */
export const LEAD_DELIVERY_STATUSES = [
  'QUEUED',
  'SENT',
  'ACCEPTED',
  'DELIVERED',
  'CRM_PARSED',
  'CRM_MATCHED',
  'CRM_REJECTED',
  'FAILED',
  'DEAD',
  'BLOCKED',
] as const;
export type DeliveryStatus = (typeof LEAD_DELIVERY_STATUSES)[number];

export type DeliveryEvidence =
  /** Row + outbox event were written. */
  | { kind: 'enqueued' }
  /** A named gate was closed. */
  | { kind: 'gate_blocked'; reason: string }
  /** The message is being handed to a transport. */
  | { kind: 'transport_handoff'; attempt: number }
  /** The transport acknowledged (e.g. SMTP 250) and returned a message id. */
  | {
      kind: 'transport_receipt';
      providerName: string;
      providerMessageId: string;
      rawStatus: string;
    }
  /**
   * The same acknowledgement, recorded AFTER another attempt had already marked the row
   * FAILED/DEAD (a lost compare-and-set). The transport did accept, so the row must say so.
   */
  | {
      kind: 'late_transport_receipt';
      providerName: string;
      providerMessageId: string;
      rawStatus: string;
    }
  | { kind: 'transport_error'; code: string; retryable: boolean }
  | { kind: 'attempts_exhausted'; code: string }
  | { kind: 'invalid_payload'; code: string }
  /** Signed provider delivery callback. */
  | { kind: 'provider_delivery_callback'; providerEventId: string }
  | { kind: 'provider_bounce'; providerEventId: string }
  /** Explicit reconciliation input from an operator / CRM export. */
  | {
      kind: 'crm_reconciliation';
      result: 'PARSED' | 'MATCHED' | 'REJECTED';
      crmRecordRef?: string | null;
      actor: string;
    }
  /**
   * Staff assertion that a previously dispatched SMTP message was accepted by the relay
   * (e.g. verified in the dealership mailbox after a crash between SMTP 250 and the ACCEPTED
   * write). Never implies CRM match. Requires the durable pre-declared Message-ID.
   */
  | {
      kind: 'operator_accept_assertion';
      actor: string;
      providerMessageId: string;
      note?: string | null;
    }
  | { kind: 'operator_replay'; actor: string }
  /** An environment-level block reason (see REEVALUABLE_BLOCK_REASONS) no longer applies. */
  | { kind: 'gate_reevaluation'; reason: string }
  /**
   * The row was acknowledged by a SANDBOX transport and the environment is now live: the sandbox
   * acknowledgement does not count, so the delivery is queued again (caller enforces the mode).
   */
  | { kind: 'sandbox_ack_superseded'; actor: string };

export type TransitionResult =
  | { ok: true; noop: false; to: DeliveryStatus }
  /** Duplicate or late event for a state already reached or passed — nothing changes. */
  | { ok: true; noop: true; reason: 'duplicate' | 'stale' }
  | { ok: false; reason: string };

/** Forward evidence ladder; a higher rank is never overwritten by a lower one. */
const RANK: Partial<Record<DeliveryStatus, number>> = {
  QUEUED: 0,
  SENT: 1,
  ACCEPTED: 2,
  DELIVERED: 3,
  CRM_PARSED: 4,
  CRM_MATCHED: 5,
};
const ACKNOWLEDGED: ReadonlySet<DeliveryStatus> = new Set([
  'ACCEPTED',
  'DELIVERED',
  'CRM_PARSED',
  'CRM_MATCHED',
  'CRM_REJECTED',
]);

const nonEmpty = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

type Rule = {
  from: ReadonlyArray<DeliveryStatus | null>;
  evidence: (e: DeliveryEvidence) => boolean;
};

const RULES: Record<DeliveryStatus, Rule[]> = {
  QUEUED: [
    { from: [null], evidence: (e) => e.kind === 'enqueued' },
    {
      from: ['FAILED', 'DEAD', 'BLOCKED'],
      evidence: (e) => e.kind === 'operator_replay' && nonEmpty(e.actor),
    },
    {
      from: ['BLOCKED'],
      evidence: (e) => e.kind === 'gate_reevaluation' && nonEmpty(e.reason),
    },
    {
      from: [
        'ACCEPTED',
        'DELIVERED',
        'CRM_PARSED',
        'CRM_MATCHED',
        'CRM_REJECTED',
      ],
      evidence: (e) => e.kind === 'sandbox_ack_superseded' && nonEmpty(e.actor),
    },
  ],
  SENT: [
    {
      // SENT → SENT re-handoff is allowed only for a stale in-flight attempt (caller enforces age).
      from: ['QUEUED', 'FAILED', 'SENT'],
      evidence: (e) =>
        e.kind === 'transport_handoff' &&
        Number.isInteger(e.attempt) &&
        e.attempt >= 1,
    },
  ],
  ACCEPTED: [
    {
      from: ['SENT'],
      evidence: (e) =>
        e.kind === 'transport_receipt' &&
        nonEmpty(e.providerName) &&
        nonEmpty(e.providerMessageId) &&
        nonEmpty(e.rawStatus),
    },
    {
      from: ['FAILED', 'DEAD'],
      evidence: (e) =>
        e.kind === 'late_transport_receipt' &&
        nonEmpty(e.providerName) &&
        nonEmpty(e.providerMessageId) &&
        nonEmpty(e.rawStatus),
    },
    {
      from: ['SENT'],
      evidence: (e) =>
        e.kind === 'operator_accept_assertion' &&
        nonEmpty(e.actor) &&
        nonEmpty(e.providerMessageId),
    },
  ],
  DELIVERED: [
    {
      from: ['ACCEPTED'],
      evidence: (e) =>
        e.kind === 'provider_delivery_callback' && nonEmpty(e.providerEventId),
    },
  ],
  CRM_PARSED: [
    {
      from: ['ACCEPTED', 'DELIVERED'],
      evidence: (e) =>
        e.kind === 'crm_reconciliation' &&
        e.result === 'PARSED' &&
        nonEmpty(e.actor),
    },
  ],
  CRM_MATCHED: [
    {
      from: ['ACCEPTED', 'DELIVERED', 'CRM_PARSED'],
      evidence: (e) =>
        e.kind === 'crm_reconciliation' &&
        e.result === 'MATCHED' &&
        nonEmpty(e.crmRecordRef) &&
        nonEmpty(e.actor),
    },
  ],
  CRM_REJECTED: [
    {
      from: ['ACCEPTED', 'DELIVERED'],
      evidence: (e) =>
        e.kind === 'crm_reconciliation' &&
        e.result === 'REJECTED' &&
        nonEmpty(e.actor),
    },
  ],
  FAILED: [
    {
      from: ['QUEUED', 'SENT', 'FAILED'],
      evidence: (e) =>
        e.kind === 'transport_error' &&
        e.retryable === true &&
        nonEmpty(e.code),
    },
  ],
  DEAD: [
    {
      from: ['QUEUED', 'SENT', 'FAILED'],
      evidence: (e) =>
        (e.kind === 'transport_error' &&
          e.retryable === false &&
          nonEmpty(e.code)) ||
        (e.kind === 'attempts_exhausted' && nonEmpty(e.code)) ||
        (e.kind === 'invalid_payload' && nonEmpty(e.code)),
    },
    {
      from: ['ACCEPTED'],
      evidence: (e) =>
        e.kind === 'provider_bounce' && nonEmpty(e.providerEventId),
    },
  ],
  BLOCKED: [
    {
      // SENT → BLOCKED only for a stale (crashed) in-flight attempt whose gate has since closed;
      // the caller enforces the age, exactly as for the SENT → SENT re-handoff.
      from: [null, 'QUEUED', 'FAILED', 'SENT'],
      evidence: (e) => e.kind === 'gate_blocked' && nonEmpty(e.reason),
    },
  ],
};

/**
 * Decide whether `from → to` is legal given `evidence`.
 *  - skipping forward without the matching evidence is illegal;
 *  - a duplicate or late event for a state already reached/passed is a no-op, never a regression;
 *  - a failure/block arriving after the transport acknowledged can never erase the acknowledgement.
 */
export function transitionDelivery(
  from: DeliveryStatus | null,
  to: DeliveryStatus,
  evidence: DeliveryEvidence,
): TransitionResult {
  const rules = RULES[to];
  if (!rules) return { ok: false, reason: 'unknown_status' };
  const isReHandoff = from === 'SENT' && to === 'SENT';
  if (from === to && !isReHandoff)
    return { ok: true, noop: true, reason: 'duplicate' };

  if (
    from !== null &&
    evidence.kind !== 'operator_replay' &&
    evidence.kind !== 'sandbox_ack_superseded'
  ) {
    const rf = RANK[from];
    const rt = RANK[to];
    // Late arrival of an earlier rung (e.g. a retried "accepted" after DELIVERED).
    if (rf !== undefined && rt !== undefined && rt < rf)
      return { ok: true, noop: true, reason: 'stale' };
    // Late failure/block after acknowledgement must not regress the row.
    if (
      ACKNOWLEDGED.has(from) &&
      (to === 'FAILED' || to === 'BLOCKED' || to === 'QUEUED' || to === 'SENT')
    )
      return { ok: true, noop: true, reason: 'stale' };
    if (
      ACKNOWLEDGED.has(from) &&
      to === 'DEAD' &&
      evidence.kind !== 'provider_bounce'
    )
      return { ok: true, noop: true, reason: 'stale' };
  }

  const fromOk = rules.filter((r) => r.from.includes(from));
  if (fromOk.length === 0)
    return { ok: false, reason: `illegal_transition:${from ?? 'NEW'}->${to}` };
  if (!fromOk.some((r) => r.evidence(evidence)))
    return { ok: false, reason: `missing_evidence:${to}` };
  return { ok: true, noop: false, to };
}

/** Statuses an operator may replay (re-queue). An acknowledged delivery is never re-sent. */
export const REPLAYABLE_STATUSES: ReadonlySet<DeliveryStatus> = new Set([
  'FAILED',
  'DEAD',
  'BLOCKED',
]);

export function isAcknowledged(status: DeliveryStatus): boolean {
  return ACKNOWLEDGED.has(status);
}

/** Column that records when a status was first reached. */
export const STATUS_TIMESTAMP_COLUMN: Record<DeliveryStatus, string> = {
  QUEUED: 'queuedAt',
  SENT: 'sentAt',
  ACCEPTED: 'acceptedAt',
  DELIVERED: 'deliveredAt',
  CRM_PARSED: 'crmParsedAt',
  CRM_MATCHED: 'crmMatchedAt',
  CRM_REJECTED: 'crmRejectedAt',
  FAILED: 'failedAt',
  DEAD: 'deadAt',
  BLOCKED: 'blockedAt',
};
