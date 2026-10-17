import { useEffect, useState } from 'react';
import { api, session } from '../api';
import { ago, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, statusTone } from '../ui';

type Q = {
  finance: Array<{ id: string; conversationId: string | null; locationId: string | null; vehicleVin: string | null; downPayment: number | null; desiredPayment: number | null; creditLinkState: string; aprSource: string; status: string; notes: string | null; createdAt: string; customerName: string | null }>;
  parts: Array<{ id: string; suspectedPart: string | null; partNumber: string | null; vin: string | null; vehicleYear: number | null; vehicleModel: string | null; status: string; installationRequested: boolean; createdAt: string; customerName: string | null }>;
  trades: Array<{ id: string; year: number | null; make: string | null; model: string | null; mileage: number | null; status: string; createdAt: string; customerName: string | null }>;
  escalations: Array<{ id: string; reason: string; urgency: string; status: string; notifiedAt: string | null; createdAt: string; conversationId: string | null }>;
  quotes?: Array<{ id: string; vehicleLabel: string | null; vehicleVin: string; paymentMethod: string; registrationZip: string | null; status: string; missingInputs: string[]; estimateShown: { total?: number } | null; createdAt: string; customerName: string | null }>;
  prioritized?: {
    unansweredInbound: Array<{ id: string; channel: string; preview: string; lastActivityAt: string; reason: string }>;
    aiUncertain: Array<{ id: string; label: string; occurredAt: string; reason: string; conversationExternalKey: string | null }>;
    overdueLeads: Array<{ id: string; firstName: string | null; lastName: string | null; stage: string | null; updatedAt: string; conversationId: string | null }>;
    missedAppointments: Array<{ id: string; type: string; status: string; requestedDate: string | null; updatedAt: string }>;
  };
};

const FINANCE_STATUSES = ['REQUESTED', 'PENDING_STAFF', 'ESTIMATE_SHARED', 'HANDED_OFF', 'CLOSED', 'CANCELLED'] as const;

export function Queues({ locationId }: { locationId: string }) {
  const { data, error, reload } = useAsync(() => api<Q>(`/ops/queues${locationId ? `?locationId=${locationId}` : ''}`), [locationId]);
  return (
    <div className="page">
      <h1>Work queues</h1>
      <ErrorNote error={error} />
      {data && (
        <div className="grid2">
          <Card title={`Unanswered inbound (${data.prioritized?.unansweredInbound.length ?? 0})`}>
            {!data.prioritized?.unansweredInbound.length ? <Empty>None aging out.</Empty> : (
              <ul className="list">
                {data.prioritized.unansweredInbound.map((u) => (
                  <li key={u.id}>
                    <span>{u.preview || 'Customer message waiting'}</span>
                    <span className="row"><Badge>{u.channel}</Badge><span className="muted small">{ago(u.lastActivityAt)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`AI needs review (${data.prioritized?.aiUncertain.length ?? 0})`}>
            {!data.prioritized?.aiUncertain.length ? <Empty>No staff flags this week.</Empty> : (
              <ul className="list">
                {data.prioritized.aiUncertain.map((a) => (
                  <li key={a.id}>
                    <span>{a.reason}</span>
                    <span className="row"><Badge tone="warn">{a.label}</Badge><span className="muted small">{ago(a.occurredAt)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Overdue hot/warm leads (${data.prioritized?.overdueLeads.length ?? 0})`}>
            {!data.prioritized?.overdueLeads.length ? <Empty>None overdue.</Empty> : (
              <ul className="list">
                {data.prioritized.overdueLeads.map((l) => (
                  <li key={l.id}>
                    <span>{[l.firstName, l.lastName].filter(Boolean).join(' ') || 'Lead'} · {l.stage}</span>
                    <span className="muted small">{ago(l.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Missed appointments (${data.prioritized?.missedAppointments.length ?? 0})`}>
            {!data.prioritized?.missedAppointments.length ? <Empty>None recorded.</Empty> : (
              <ul className="list">
                {data.prioritized.missedAppointments.map((a) => (
                  <li key={a.id}>
                    <span>{a.type} · {a.requestedDate ?? '—'}</span>
                    <Badge tone="bad">{a.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Handoffs (${data.escalations.length})`}>
            {!data.escalations.length ? <Empty>None open.</Empty> : (
              <ul className="list">
                {data.escalations.map((e) => (
                  <li key={e.id}>
                    <span>{e.reason}</span>
                    <span className="row"><Badge tone={e.urgency === 'HIGH' || e.urgency === 'CRITICAL' ? 'bad' : 'neutral'}>{e.urgency}</Badge><Badge tone={e.notifiedAt ? 'ok' : 'warn'}>{e.notifiedAt ? 'notified' : 'not delivered'}</Badge><span className="muted small">{ago(e.createdAt)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Parts (${data.parts.length})`}>
            {!data.parts.length ? <Empty>None open.</Empty> : (
              <ul className="list">
                {data.parts.map((p) => (
                  <li key={p.id}>
                    <span>{p.suspectedPart ?? p.partNumber ?? 'Parts request'} · {[p.vehicleYear, p.vehicleModel].filter(Boolean).join(' ')} {p.customerName ? `· ${p.customerName}` : ''}</span>
                    <span className="row">{!p.vin && !p.partNumber && <Badge tone="warn">needs VIN</Badge>}{p.installationRequested && <Badge tone="info">install</Badge>}<Badge tone={statusTone(p.status)}>{p.status}</Badge></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Finance (${data.finance.length})`}>
            {!data.finance.length ? <Empty>None open.</Empty> : (
              <ul className="list">
                {data.finance.map((f) => (
                  <li key={f.id} className="stack">
                    <span className="row">
                      <span>{f.customerName ?? 'Visitor'} · {f.vehicleVin ?? 'no vehicle'} {f.downPayment ? `· $${f.downPayment.toLocaleString()} down` : ''} {f.desiredPayment ? `· target $${f.desiredPayment}/mo` : ''}</span>
                      <Badge tone={statusTone(f.status)}>{f.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                    </span>
                    <span className="row"><Badge tone={statusTone(f.creditLinkState)}>credit {f.creditLinkState.toLowerCase()}</Badge><span className="muted small">{ago(f.createdAt)}</span></span>
                    <FinanceActions
                      financeId={f.id}
                      conversationId={f.conversationId}
                      status={f.status}
                      notes={f.notes}
                      locationId={locationId || f.locationId || ''}
                      onUpdated={() => void reload()}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Out-the-door quotes (${data.quotes?.length ?? 0})`}>
            {!data.quotes?.length ? <Empty>None open.</Empty> : (
              <ul className="list">
                {data.quotes.map((q) => (
                  <li key={q.id}>
                    <span>{q.vehicleLabel ?? q.vehicleVin} {q.customerName ? `· ${q.customerName}` : ''} {q.registrationZip ? `· ZIP ${q.registrationZip}` : ''}</span>
                    <span className="row">
                      <Badge tone={q.paymentMethod === 'CASH' ? 'info' : 'neutral'}>{q.paymentMethod.toLowerCase()}</Badge>
                      {q.estimateShown?.total != null ? <Badge tone="ok">estimate shown ${Math.round(q.estimateShown.total).toLocaleString()}</Badge> : <Badge tone="warn">needs written quote</Badge>}
                      <span className="muted small">{ago(q.createdAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Trade-ins (${data.trades.length})`}>
            {!data.trades.length ? <Empty>None open.</Empty> : (
              <ul className="list">
                {data.trades.map((t) => (
                  <li key={t.id} className="stack">
                    <span className="row">
                      <span>{[t.year, t.make, t.model].filter(Boolean).join(' ') || 'Vehicle'} {t.mileage ? `· ${t.mileage.toLocaleString()} mi` : ''} {t.customerName ? `· ${t.customerName}` : ''}</span>
                      <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                    </span>
                    <TradeActions tradeId={t.id} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

type CreditStatus = {
  enabled: boolean;
  vault: null | { authorized: boolean; linkType: string };
  customerFacing: { available: boolean; preview?: boolean; reason?: string };
};

/** Status, internal notes, and rooftop credit authorization (fail-closed — no invented approvals). */
function FinanceActions(props: {
  financeId: string;
  conversationId: string | null;
  status: string;
  notes: string | null;
  locationId: string;
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
        <button className="btn btn--ghost" disabled={status === props.status} onClick={() => void patch({ status })}>Update status</button>
      </span>
      <label>
        Internal notes (finance record)
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Staff-only" />
      </label>
      <button className="btn btn--ghost" disabled={notes === (props.notes ?? '')} onClick={() => void patch({ notes })}>Save notes</button>
      {props.conversationId && (
        <span className="row">
          <input value={convNote} onChange={(e) => setConvNote(e.target.value)} placeholder="Conversation note (inbox)" aria-label="Conversation note" />
          <button className="btn btn--ghost" disabled={!convNote.trim()} onClick={() => void saveConvNote()}>Add inbox note</button>
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
              <button className="btn" disabled={evidence.trim().length < 6} onClick={() => void authorizeCredit()}>Record authorization</button>
            </span>
          )}
        </span>
      )}
      {msg && <span className="muted">{msg}</span>}
    </span>
  );
}

/** Staff record an appraisal; managers issue an expiring offer (the only value customers see). */
function TradeActions({ tradeId }: { tradeId: string }) {
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState('7');
  const [msg, setMsg] = useState<string | null>(null);
  const isManager = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(session.user?.role ?? '');
  const post = async (path: string, body: unknown, ok: string) => {
    setMsg(null);
    try {
      await api(`/ops/trades/${tradeId}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  const n = Number(amount);
  return (
    <span className="row small">
      <label>Amount $<input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 90 }} /></label>
      <button className="btn btn--ghost" disabled={!(n > 0)} onClick={() => void post('appraisals', { amount: n }, 'Appraisal recorded (internal)')}>Record appraisal</button>
      {isManager && (
        <>
          <label>Valid days<input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 44 }} /></label>
          <button className="btn" disabled={!(n > 0)} onClick={() => void post('offer', { amount: n, validDays: Number(days) || 7 }, 'Offer issued — visible to the customer')}>Issue offer</button>
        </>
      )}
      {msg && <span className="muted">{msg}</span>}
    </span>
  );
}
