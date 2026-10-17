import { useEffect, useState } from 'react';
import { api, session } from '../api';
import { useAsync } from '../hooks';
import type { EscalationRow } from '../EscalationActions';
import { Badge } from '../ui';

export type OpsQueuesPayload = {
  appointments: Array<{
    id: string;
    conversationId: string | null;
    locationId: string | null;
    type: string;
    status: string;
    requestedDate: string | null;
    requestedTime: string | null;
    requestedAt: string | null;
    scheduledAt: string | null;
    vehicleVin: string | null;
    serviceType: string | null;
    transportation: string | null;
    notes: string | null;
    availabilityVerified: boolean;
    provider: string;
    customerName: string | null;
    createdAt: string;
  }>;
  finance: Array<{
    id: string;
    conversationId: string | null;
    locationId: string | null;
    vehicleVin: string | null;
    downPayment: number | null;
    desiredPayment: number | null;
    creditLinkState: string;
    aprSource: string;
    status: string;
    notes: string | null;
    createdAt: string;
    customerName: string | null;
  }>;
  parts: Array<{
    id: string;
    conversationId: string | null;
    locationId: string | null;
    suspectedPart: string | null;
    partNumber: string | null;
    vin: string | null;
    vehicleYear: number | null;
    vehicleModel: string | null;
    status: string;
    notes: string | null;
    installationRequested: boolean;
    fitmentVerified: boolean;
    priceVerified: boolean;
    availabilityVerified: boolean;
    createdAt: string;
    customerName: string | null;
  }>;
  trades: Array<{
    id: string;
    conversationId: string | null;
    locationId: string | null;
    year: number | null;
    make: string | null;
    model: string | null;
    mileage: number | null;
    status: string;
    notes: string | null;
    createdAt: string;
    customerName: string | null;
  }>;
  escalations: EscalationRow[];
  quotes?: Array<{
    id: string;
    vehicleLabel: string | null;
    vehicleVin: string;
    paymentMethod: string;
    registrationZip: string | null;
    status: string;
    missingInputs: string[];
    estimateShown: { total?: number } | null;
    createdAt: string;
    customerName: string | null;
  }>;
  prioritized?: {
    unansweredInbound: Array<{ id: string; channel: string; preview: string; lastActivityAt: string; reason: string }>;
    aiUncertain: Array<{ id: string; label: string; occurredAt: string; reason: string; conversationExternalKey: string | null }>;
    overdueLeads: Array<{ id: string; firstName: string | null; lastName: string | null; stage: string | null; updatedAt: string; conversationId: string | null }>;
    missedAppointments: Array<{ id: string; type: string; status: string; requestedDate: string | null; updatedAt: string }>;
  };
};

export const PARTS_STATUSES = ['REQUESTED', 'PENDING_STAFF', 'FITMENT_PENDING', 'QUOTED', 'ORDERED', 'CLOSED', 'CANCELLED'] as const;
export const APPOINTMENT_STAFF_STATUSES = ['PENDING_CONFIRMATION', 'CONFIRMED', 'CANCELLED'] as const;
export const FINANCE_STATUSES = ['REQUESTED', 'PENDING_STAFF', 'ESTIMATE_SHARED', 'HANDED_OFF', 'CLOSED', 'CANCELLED'] as const;

type CreditStatus = {
  enabled: boolean;
  vault: null | { authorized: boolean; linkType: string };
  customerFacing: { available: boolean; preview?: boolean; reason?: string };
};

/** Ack missed no-show / cancel recovery — no outbound SMS. */
export function MissedRecoveryActions(props: {
  appointmentId: string;
  locationId: string;
  onUpdated: () => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const locQ = props.locationId ? `?locationId=${encodeURIComponent(props.locationId)}` : '';
  const ack = async () => {
    setMsg(null);
    try {
      await api(`/ops/appointment-requests/${props.appointmentId}${locQ}`, {
        method: 'PATCH',
        body: JSON.stringify({ acknowledgeMissedRecovery: true }),
      });
      setMsg('Recovery acked');
      props.onUpdated();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  return (
    <span className="row small">
      <button type="button" className="btn btn--ghost" onClick={() => void ack()}>
        Ack recovery follow-up
      </button>
      {msg && <span className="muted">{msg}</span>}
    </span>
  );
}

/** Status and internal notes — never claims repair-order / DMS readiness. */
export function AppointmentRequestActions(props: {
  appointmentId: string;
  conversationId: string | null;
  status: string;
  notes: string | null;
  requestedAt: string | null;
  locationId: string;
  openServiceAdvisor?: boolean;
  onUpdated: () => void;
}) {
  const [status, setStatus] = useState(props.status);
  const [notes, setNotes] = useState(props.notes ?? '');
  useEffect(() => {
    setStatus(props.status);
    setNotes(props.notes ?? '');
  }, [props.appointmentId, props.status, props.notes]);
  const [convNote, setConvNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const locQ = props.locationId ? `?locationId=${encodeURIComponent(props.locationId)}` : '';
  const patch = async (body: { status?: string; notes?: string; scheduledAt?: string; acknowledgeEscalation?: boolean }) => {
    setMsg(null);
    try {
      await api(`/ops/appointment-requests/${props.appointmentId}${locQ}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setMsg('Saved');
      props.onUpdated();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  const saveConvNote = async () => {
    if (!props.conversationId || !convNote.trim()) return;
    setMsg(null);
    try {
      await api(`/ops/conversations/${props.conversationId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ text: convNote.trim() }),
      });
      setConvNote('');
      setMsg('Conversation note saved (internal)');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  const confirmWithSlot = () => {
    const defaultAt = props.requestedAt?.slice(0, 16) ?? '';
    const at = window.prompt(
      'Confirmed date/time (ISO). Uses customer preference if you leave blank.',
      defaultAt,
    );
    if (at === null) return;
    const scheduledAt = at.trim()
      ? new Date(at).toISOString()
      : props.requestedAt ?? undefined;
    void patch({
      status: 'CONFIRMED',
      ...(scheduledAt ? { scheduledAt } : {}),
    });
  };
  return (
    <span className="stack small">
      <span className="row">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {[props.status, ...APPOINTMENT_STAFF_STATUSES.filter((s) => s !== props.status)].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>
            ))}
          </select>
        </label>
        {status === 'CONFIRMED' && status !== props.status ? (
          <button type="button" className="btn btn--ghost" onClick={() => confirmWithSlot()}>Confirm slot</button>
        ) : (
          <button type="button" className="btn btn--ghost" disabled={status === props.status} onClick={() => void patch({ status })}>Update status</button>
        )}
      </span>
      <label>
        Internal notes (appointment record)
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Staff-only — not repair-order status" />
      </label>
      <button type="button" className="btn btn--ghost" disabled={notes === (props.notes ?? '')} onClick={() => void patch({ notes })}>Save notes</button>
      {props.openServiceAdvisor && (
        <button type="button" className="btn btn--ghost" onClick={() => void patch({ acknowledgeEscalation: true })}>Acknowledge service advisor handoff</button>
      )}
      {props.conversationId && (
        <span className="row">
          <input value={convNote} onChange={(e) => setConvNote(e.target.value)} placeholder="Conversation note (inbox)" aria-label="Conversation note" />
          <button type="button" className="btn btn--ghost" disabled={!convNote.trim()} onClick={() => void saveConvNote()}>Add inbox note</button>
        </span>
      )}
      {msg && <span className="muted">{msg}</span>}
    </span>
  );
}

/** Status and internal notes — fitment/price stay unverified until a parts provider confirms. */
export function PartsActions(props: {
  partsId: string;
  conversationId: string | null;
  status: string;
  notes: string | null;
  locationId: string;
  openPartsAdvisor: boolean;
  onUpdated: () => void;
}) {
  const [status, setStatus] = useState(props.status);
  const [notes, setNotes] = useState(props.notes ?? '');
  useEffect(() => {
    setStatus(props.status);
    setNotes(props.notes ?? '');
  }, [props.partsId, props.status, props.notes]);
  const [convNote, setConvNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const locQ = props.locationId ? `?locationId=${encodeURIComponent(props.locationId)}` : '';
  const patch = async (body: { status?: string; notes?: string; acknowledgeEscalation?: boolean }) => {
    setMsg(null);
    try {
      await api(`/ops/parts-inquiries/${props.partsId}${locQ}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setMsg('Saved');
      props.onUpdated();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  const saveConvNote = async () => {
    if (!props.conversationId || !convNote.trim()) return;
    setMsg(null);
    try {
      await api(`/ops/conversations/${props.conversationId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ text: convNote.trim() }),
      });
      setConvNote('');
      setMsg('Conversation note saved (internal)');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  return (
    <span className="stack small">
      <span className="row">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {PARTS_STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn--ghost" disabled={status === props.status} onClick={() => void patch({ status })}>Update status</button>
      </span>
      <label>
        Internal notes (parts record)
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Staff-only — no customer-facing fitment/price" />
      </label>
      <button type="button" className="btn btn--ghost" disabled={notes === (props.notes ?? '')} onClick={() => void patch({ notes })}>Save notes</button>
      {props.openPartsAdvisor && (
        <button type="button" className="btn btn--ghost" onClick={() => void patch({ acknowledgeEscalation: true })}>Acknowledge parts advisor handoff</button>
      )}
      {props.conversationId && (
        <span className="row">
          <input value={convNote} onChange={(e) => setConvNote(e.target.value)} placeholder="Conversation note (inbox)" aria-label="Conversation note" />
          <button type="button" className="btn btn--ghost" disabled={!convNote.trim()} onClick={() => void saveConvNote()}>Add inbox note</button>
        </span>
      )}
      {msg && <span className="muted">{msg}</span>}
    </span>
  );
}

/** Status, internal notes, and rooftop credit authorization (fail-closed — no invented approvals). */
export function FinanceActions(props: {
  financeId: string;
  conversationId: string | null;
  status: string;
  notes: string | null;
  locationId: string;
  openFinanceAdvisor?: boolean;
  onUpdated: () => void;
}) {
  const [status, setStatus] = useState(props.status);
  const [notes, setNotes] = useState(props.notes ?? '');
  useEffect(() => {
    setStatus(props.status);
    setNotes(props.notes ?? '');
  }, [props.financeId, props.status, props.notes]);
  const [convNote, setConvNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [linkType, setLinkType] = useState('DEALER_REUSABLE');
  const [evidence, setEvidence] = useState('');
  const role = session.user?.role ?? '';
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(role);
  const canViewCredit = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(role);
  const creditLoc = props.locationId || null;
  const credit = useAsync(
    () =>
      creditLoc && canViewCredit
        ? api<CreditStatus>(`/ops/locations/${creditLoc}/credit-application`)
        : Promise.resolve(null),
    [creditLoc, canViewCredit],
  );
  const locQ = props.locationId ? `?locationId=${encodeURIComponent(props.locationId)}` : '';
  const patch = async (body: { status?: string; notes?: string }) => {
    setMsg(null);
    try {
      await api(`/ops/finance-requests/${props.financeId}${locQ}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setMsg('Saved');
      props.onUpdated();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  const saveConvNote = async () => {
    if (!props.conversationId || !convNote.trim()) return;
    setMsg(null);
    try {
      await api(`/ops/conversations/${props.conversationId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ text: convNote.trim() }),
      });
      setConvNote('');
      setMsg('Conversation note saved (internal)');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  const authorizeCredit = async () => {
    if (!creditLoc || evidence.trim().length < 6) return;
    setMsg(null);
    try {
      await api(`/ops/locations/${creditLoc}/credit-application/authorize`, {
        method: 'POST',
        body: JSON.stringify({ linkType, evidenceRef: evidence.trim() }),
      });
      setEvidence('');
      await credit.reload();
      setMsg('Authorization recorded — live only if destination is configured');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  const cf = credit.data?.customerFacing;
  return (
    <span className="stack small">
      <span className="row">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {FINANCE_STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn--ghost" disabled={status === props.status} onClick={() => void patch({ status })}>Update status</button>
      </span>
      <label>
        Internal notes (finance record)
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Staff-only" />
      </label>
      <button type="button" className="btn btn--ghost" disabled={notes === (props.notes ?? '')} onClick={() => void patch({ notes })}>Save notes</button>
      {props.conversationId && (
        <span className="row">
          <input value={convNote} onChange={(e) => setConvNote(e.target.value)} placeholder="Conversation note (inbox)" aria-label="Conversation note" />
          <button type="button" className="btn btn--ghost" disabled={!convNote.trim()} onClick={() => void saveConvNote()}>Add inbox note</button>
        </span>
      )}
      {creditLoc && (
        <span className="stack">
          <span className="row">
            <span className="muted">Credit app for rooftop:</span>
            {canViewCredit ? (
              cf ? (
                <Badge tone={cf.available ? (cf.preview ? 'warn' : 'ok') : 'neutral'}>
                  {cf.available ? (cf.preview ? 'demo preview' : 'live') : `off — ${(cf.reason ?? 'not_ready').replace(/_/g, ' ')}`}
                </Badge>
              ) : (
                <span className="muted">loading…</span>
              )
            ) : (
              <span className="muted">managers configure in settings</span>
            )}
            {canViewCredit && <a className="small" href="#/settings">Rooftop settings</a>}
          </span>
          {isAdmin && credit.data?.vault && !credit.data.vault.authorized && (
            <span className="row">
              <select value={linkType} onChange={(e) => setLinkType(e.target.value)} aria-label="Link type">
                <option value="DEALER_REUSABLE">Reusable for this rooftop</option>
                <option value="PUBLIC_REUSABLE">Public reusable link</option>
                <option value="PER_CUSTOMER">Per-customer link</option>
              </select>
              <input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Written approval ref" aria-label="Approval reference" />
              <button type="button" className="btn" disabled={evidence.trim().length < 6} onClick={() => void authorizeCredit()}>Record authorization</button>
            </span>
          )}
        </span>
      )}
      {msg && <span className="muted">{msg}</span>}
    </span>
  );
}
