import {
  DeliveryEvidence,
  DeliveryStatus,
  isAcknowledged,
  LEAD_DELIVERY_STATUSES,
  REPLAYABLE_STATUSES,
  transitionDelivery,
} from './lead-delivery-state';

const E = {
  enqueued: { kind: 'enqueued' } as DeliveryEvidence,
  handoff: { kind: 'transport_handoff', attempt: 1 } as DeliveryEvidence,
  receipt: {
    kind: 'transport_receipt',
    providerName: 'smtp',
    providerMessageId: '<m@x>',
    rawStatus: '250 OK',
  } as DeliveryEvidence,
  callback: {
    kind: 'provider_delivery_callback',
    providerEventId: 'evt-1',
  } as DeliveryEvidence,
  parsed: {
    kind: 'crm_reconciliation',
    result: 'PARSED',
    actor: 'user-1',
  } as DeliveryEvidence,
  matched: {
    kind: 'crm_reconciliation',
    result: 'MATCHED',
    crmRecordRef: 'CRM-123',
    actor: 'user-1',
  } as DeliveryEvidence,
  rejected: {
    kind: 'crm_reconciliation',
    result: 'REJECTED',
    actor: 'user-1',
  } as DeliveryEvidence,
  retryable: {
    kind: 'transport_error',
    code: 'smtp_deferred_451',
    retryable: true,
  } as DeliveryEvidence,
  permanent: {
    kind: 'transport_error',
    code: 'smtp_rejected_550',
    retryable: false,
  } as DeliveryEvidence,
  exhausted: {
    kind: 'attempts_exhausted',
    code: 'smtp_error',
  } as DeliveryEvidence,
  invalid: {
    kind: 'invalid_payload',
    code: 'adf_too_large',
  } as DeliveryEvidence,
  blocked: {
    kind: 'gate_blocked',
    reason: 'route_unverified',
  } as DeliveryEvidence,
  replay: { kind: 'operator_replay', actor: 'user-1' } as DeliveryEvidence,
  bounce: {
    kind: 'provider_bounce',
    providerEventId: 'b-1',
  } as DeliveryEvidence,
};
const go = (
  from: DeliveryStatus | null,
  to: DeliveryStatus,
  e: DeliveryEvidence,
) => transitionDelivery(from, to, e);
const moved = (to: DeliveryStatus) => ({ ok: true, noop: false, to });

describe('lead delivery state machine', () => {
  it('walks the full evidence ladder', () => {
    expect(go(null, 'QUEUED', E.enqueued)).toEqual(moved('QUEUED'));
    expect(go('QUEUED', 'SENT', E.handoff)).toEqual(moved('SENT'));
    expect(go('SENT', 'ACCEPTED', E.receipt)).toEqual(moved('ACCEPTED'));
    expect(go('ACCEPTED', 'DELIVERED', E.callback)).toEqual(moved('DELIVERED'));
    expect(go('DELIVERED', 'CRM_PARSED', E.parsed)).toEqual(
      moved('CRM_PARSED'),
    );
    expect(go('CRM_PARSED', 'CRM_MATCHED', E.matched)).toEqual(
      moved('CRM_MATCHED'),
    );
  });

  it('plain SMTP has no delivery callback: reconciliation may follow ACCEPTED directly', () => {
    expect(go('ACCEPTED', 'CRM_PARSED', E.parsed)).toEqual(moved('CRM_PARSED'));
    expect(go('ACCEPTED', 'CRM_MATCHED', E.matched)).toEqual(
      moved('CRM_MATCHED'),
    );
    expect(go('ACCEPTED', 'CRM_REJECTED', E.rejected)).toEqual(
      moved('CRM_REJECTED'),
    );
  });

  it('never skips forward without the state before it', () => {
    expect(go(null, 'SENT', E.handoff).ok).toBe(false);
    expect(go(null, 'ACCEPTED', E.receipt).ok).toBe(false);
    expect(go('QUEUED', 'ACCEPTED', E.receipt)).toEqual({
      ok: false,
      reason: 'illegal_transition:QUEUED->ACCEPTED',
    });
    expect(go('QUEUED', 'DELIVERED', E.callback).ok).toBe(false);
    expect(go('SENT', 'DELIVERED', E.callback).ok).toBe(false);
    expect(go('QUEUED', 'CRM_MATCHED', E.matched).ok).toBe(false);
    expect(go('SENT', 'CRM_MATCHED', E.matched).ok).toBe(false);
    expect(go('SENT', 'CRM_PARSED', E.parsed).ok).toBe(false);
    expect(go('FAILED', 'ACCEPTED', E.receipt).ok).toBe(false);
    expect(go('BLOCKED', 'SENT', E.handoff).ok).toBe(false);
    expect(go('DEAD', 'SENT', E.handoff).ok).toBe(false);
  });

  it('never advances on the wrong or incomplete evidence', () => {
    // SMTP acceptance is not delivery and not a CRM match.
    expect(go('ACCEPTED', 'DELIVERED', E.receipt)).toEqual({
      ok: false,
      reason: 'missing_evidence:DELIVERED',
    });
    expect(go('ACCEPTED', 'CRM_MATCHED', E.receipt).ok).toBe(false);
    expect(go('ACCEPTED', 'DELIVERED', E.parsed).ok).toBe(false);
    // ACCEPTED needs a provider name, a message id and a status line.
    for (const bad of [
      { ...E.receipt, providerMessageId: '' },
      { ...E.receipt, providerName: ' ' },
      { ...E.receipt, rawStatus: '' },
      E.handoff,
    ] as DeliveryEvidence[])
      expect(go('SENT', 'ACCEPTED', bad).ok).toBe(false);
    // CRM_MATCHED needs a CRM record reference.
    for (const ref of [undefined, null, '', '  '])
      expect(
        go('ACCEPTED', 'CRM_MATCHED', {
          kind: 'crm_reconciliation',
          result: 'MATCHED',
          crmRecordRef: ref,
          actor: 'user-1',
        }).ok,
      ).toBe(false);
    // A "parsed" result cannot be recorded as matched, nor a rejection as parsed.
    expect(go('ACCEPTED', 'CRM_MATCHED', E.parsed).ok).toBe(false);
    expect(go('ACCEPTED', 'CRM_PARSED', E.rejected).ok).toBe(false);
    expect(
      go('QUEUED', 'SENT', { kind: 'transport_handoff', attempt: 0 }).ok,
    ).toBe(false);
    expect(
      go('QUEUED', 'BLOCKED', { kind: 'gate_blocked', reason: '' }).ok,
    ).toBe(false);
    expect(go('SENT', 'FAILED', E.permanent).ok).toBe(false);
    expect(go('SENT', 'DEAD', E.retryable).ok).toBe(false);
  });

  it('duplicate and late events are no-ops, never regressions', () => {
    expect(go('ACCEPTED', 'ACCEPTED', E.receipt)).toEqual({
      ok: true,
      noop: true,
      reason: 'duplicate',
    });
    expect(go('CRM_MATCHED', 'CRM_MATCHED', E.matched)).toMatchObject({
      noop: true,
    });
    // An earlier rung arriving late.
    expect(go('DELIVERED', 'ACCEPTED', E.receipt)).toEqual({
      ok: true,
      noop: true,
      reason: 'stale',
    });
    expect(go('CRM_MATCHED', 'CRM_PARSED', E.parsed)).toMatchObject({
      noop: true,
    });
    expect(go('CRM_MATCHED', 'DELIVERED', E.callback)).toMatchObject({
      noop: true,
    });
    expect(go('CRM_PARSED', 'SENT', E.handoff)).toMatchObject({ noop: true });
    // A late failure / block cannot erase an acknowledgement.
    for (const from of [
      'ACCEPTED',
      'DELIVERED',
      'CRM_PARSED',
      'CRM_MATCHED',
      'CRM_REJECTED',
    ] as DeliveryStatus[]) {
      expect(go(from, 'FAILED', E.retryable)).toMatchObject({ noop: true });
      expect(go(from, 'DEAD', E.permanent)).toMatchObject({ noop: true });
      expect(go(from, 'BLOCKED', E.blocked)).toMatchObject({ noop: true });
      expect(go(from, 'SENT', E.handoff)).toMatchObject({ noop: true });
    }
  });

  it('terminal CRM outcomes cannot be rewritten', () => {
    expect(go('CRM_REJECTED', 'CRM_MATCHED', E.matched).ok).toBe(false);
    expect(go('CRM_REJECTED', 'CRM_PARSED', E.parsed).ok).toBe(false);
    expect(go('CRM_MATCHED', 'CRM_REJECTED', E.rejected).ok).toBe(false);
    expect(go('CRM_PARSED', 'CRM_REJECTED', E.rejected).ok).toBe(false);
  });

  it('failure paths: retry, permanent, exhausted, invalid payload, block', () => {
    expect(go('SENT', 'FAILED', E.retryable)).toEqual(moved('FAILED'));
    expect(
      go('FAILED', 'SENT', { kind: 'transport_handoff', attempt: 2 }),
    ).toEqual(moved('SENT'));
    expect(go('SENT', 'DEAD', E.permanent)).toEqual(moved('DEAD'));
    expect(go('SENT', 'DEAD', E.exhausted)).toEqual(moved('DEAD'));
    expect(go('QUEUED', 'DEAD', E.invalid)).toEqual(moved('DEAD'));
    expect(go('QUEUED', 'BLOCKED', E.blocked)).toEqual(moved('BLOCKED'));
    expect(go('FAILED', 'BLOCKED', E.blocked)).toEqual(moved('BLOCKED'));
    // R4: a stale SENT row whose gate later closed can be blocked (caller enforces staleness).
    expect(go('SENT', 'BLOCKED', E.blocked)).toEqual(moved('BLOCKED'));
    expect(go('ACCEPTED', 'DEAD', E.bounce)).toEqual(moved('DEAD'));
    // A crashed in-flight attempt may be handed off again (caller enforces staleness).
    expect(
      go('SENT', 'SENT', { kind: 'transport_handoff', attempt: 2 }),
    ).toEqual(moved('SENT'));
  });

  it('only FAILED / DEAD / BLOCKED can be replayed, and only by an operator', () => {
    for (const from of ['FAILED', 'DEAD', 'BLOCKED'] as DeliveryStatus[]) {
      expect(go(from, 'QUEUED', E.replay)).toEqual(moved('QUEUED'));
      expect(go(from, 'QUEUED', E.enqueued).ok).toBe(false);
      expect(
        go(from, 'QUEUED', { kind: 'operator_replay', actor: '' }).ok,
      ).toBe(false);
    }
    for (const from of LEAD_DELIVERY_STATUSES.filter(
      (s) => !REPLAYABLE_STATUSES.has(s) && s !== 'QUEUED',
    ))
      expect(go(from, 'QUEUED', E.replay).ok).toBe(false);
    expect(isAcknowledged('ACCEPTED')).toBe(true);
    expect(isAcknowledged('SENT')).toBe(false);
  });

  it('every status is a distinct state with its own rules', () => {
    expect(new Set(LEAD_DELIVERY_STATUSES).size).toBe(10);
    expect(LEAD_DELIVERY_STATUSES).toEqual(
      expect.arrayContaining([
        'QUEUED',
        'SENT',
        'ACCEPTED',
        'DELIVERED',
        'CRM_PARSED',
        'CRM_MATCHED',
        'FAILED',
        'DEAD',
        'BLOCKED',
      ]),
    );
  });
});
