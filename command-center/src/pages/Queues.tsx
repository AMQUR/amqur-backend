import { useState } from 'react';
import { api, session } from '../api';
import { ago, useAsync } from '../hooks';
import { EscalationActions } from '../EscalationActions';
import { Badge, Card, Empty, ErrorNote, statusTone } from '../ui';
import {
  AppointmentRequestActions,
  FinanceActions,
  PartsActions,
  type OpsQueuesPayload,
} from './opsQueueShared';

export function Queues({ locationId }: { locationId: string }) {
  const { data, error, reload } = useAsync(() => api<OpsQueuesPayload>(`/ops/queues${locationId ? `?locationId=${locationId}` : ''}`), [locationId]);
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
                  <li key={e.id} className="stack">
                    <span className="row">
                      <span>{e.reason}{e.summary ? ` · ${e.summary.slice(0, 120)}` : ''}</span>
                      <Badge tone={e.urgency === 'HIGH' || e.urgency === 'CRITICAL' ? 'bad' : 'neutral'}>{e.urgency}</Badge>
                    </span>
                    <span className="row">
                      <Badge tone={e.notifiedAt ? 'ok' : 'warn'}>{e.notifiedAt ? 'CRM notified' : 'no outbound notify'}</Badge>
                      <span className="muted small">{e.createdAt ? ago(e.createdAt) : ''}</span>
                      {e.conversationId && (
                        <a className="small" href={`#/inbox?conversation=${e.conversationId}`}>Open inbox</a>
                      )}
                    </span>
                    <EscalationActions escalation={e} onUpdated={() => void reload()} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Service & appointment requests (${data.appointments?.length ?? 0})`}>
            {!data.appointments?.length ? <Empty>None awaiting staff.</Empty> : (
              <ul className="list">
                {data.appointments.map((a) => {
                  const openServiceAdvisor = data.escalations.some(
                    (e) =>
                      e.reason === 'SERVICE_ADVISOR' &&
                      e.status === 'OPEN' &&
                      e.conversationId === a.conversationId,
                  );
                  return (
                  <li key={a.id} className="stack">
                    <span className="row">
                      <span>
                        {a.type === 'SERVICE' ? 'Service' : a.type.replace(/_/g, ' ').toLowerCase()} · {a.requestedDate ?? '—'} {a.requestedTime ?? ''}
                        {a.customerName ? ` · ${a.customerName}` : ''}
                      </span>
                      <Badge tone={statusTone(a.status)}>{a.status === 'REQUESTED' ? 'request' : a.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                    </span>
                    <span className="row">
                      {!a.availabilityVerified && a.status !== 'CONFIRMED' && <Badge tone="warn">not confirmed</Badge>}
                      {a.status === 'CONFIRMED' && <Badge tone="ok">confirmed</Badge>}
                      {(a.serviceType || a.vehicleVin) && <Badge tone="info">{a.serviceType ?? a.vehicleVin}</Badge>}
                      {a.transportation && <Badge tone="neutral">{a.transportation}</Badge>}
                      {a.provider !== 'NONE' && <Badge tone="ok">{a.provider}</Badge>}
                      {openServiceAdvisor && <Badge tone="warn">service advisor handoff</Badge>}
                      <span className="muted small">{ago(a.createdAt)}</span>
                      {a.conversationId && (
                        <a className="small" href={`#/inbox?conversation=${a.conversationId}`}>Open inbox</a>
                      )}
                    </span>
                    <AppointmentRequestActions
                      appointmentId={a.id}
                      conversationId={a.conversationId}
                      status={a.status}
                      notes={a.notes}
                      requestedAt={a.requestedAt}
                      locationId={locationId || a.locationId || ''}
                      openServiceAdvisor={openServiceAdvisor}
                      onUpdated={() => void reload()}
                    />
                  </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title={`Parts (${data.parts.length})`}>
            {!data.parts.length ? <Empty>None open.</Empty> : (
              <ul className="list">
                {data.parts.map((p) => {
                  const openPartsAdvisor = data.escalations.some(
                    (e) =>
                      e.reason === 'PARTS_ADVISOR' &&
                      e.status === 'OPEN' &&
                      e.conversationId === p.conversationId,
                  );
                  return (
                  <li key={p.id} className="stack">
                    <span className="row">
                      <span>{p.suspectedPart ?? p.partNumber ?? 'Parts request'} · {[p.vehicleYear, p.vehicleModel].filter(Boolean).join(' ')} {p.customerName ? `· ${p.customerName}` : ''}</span>
                      <Badge tone={statusTone(p.status)}>{p.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                    </span>
                    <span className="row">
                      {!p.vin && !p.partNumber && <Badge tone="warn">needs VIN</Badge>}
                      {!p.fitmentVerified && <Badge tone="warn">fitment unverified</Badge>}
                      {p.status === 'QUOTED' && !p.priceVerified && <Badge tone="warn">quote not verified</Badge>}
                      {p.priceVerified && <Badge tone="ok">price verified</Badge>}
                      {p.availabilityVerified && <Badge tone="ok">stock verified</Badge>}
                      {p.installationRequested && <Badge tone="info">install</Badge>}
                      {openPartsAdvisor && <Badge tone="warn">advisor handoff</Badge>}
                      <span className="muted small">{ago(p.createdAt)}</span>
                    </span>
                    <PartsActions
                      partsId={p.id}
                      conversationId={p.conversationId}
                      status={p.status}
                      notes={p.notes}
                      locationId={locationId || p.locationId || ''}
                      openPartsAdvisor={openPartsAdvisor}
                      onUpdated={() => void reload()}
                    />
                  </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title={`Finance (${data.finance.length})`}>
            {!data.finance.length ? <Empty>None open.</Empty> : (
              <ul className="list">
                {data.finance.map((f) => {
                  const openFinanceAdvisor = data.escalations.some(
                    (e) =>
                      e.reason === 'FINANCE_ADVISOR' &&
                      e.status === 'OPEN' &&
                      e.conversationId === f.conversationId,
                  );
                  return (
                  <li key={f.id} className="stack">
                    <span className="row">
                      <span>{f.customerName ?? 'Visitor'} · {f.vehicleVin ?? 'no vehicle'} {f.downPayment ? `· $${f.downPayment.toLocaleString()} down` : ''} {f.desiredPayment ? `· target $${f.desiredPayment}/mo` : ''}</span>
                      <Badge tone={statusTone(f.status)}>{f.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                    </span>
                    <span className="row">
                      <Badge tone={statusTone(f.creditLinkState)}>credit {f.creditLinkState.toLowerCase()}</Badge>
                      {openFinanceAdvisor && <Badge tone="warn">advisor handoff</Badge>}
                      <span className="muted small">{ago(f.createdAt)}</span>
                      {f.conversationId && (
                        <a className="small" href={`#/inbox?conversation=${f.conversationId}`}>
                          Open inbox
                        </a>
                      )}
                    </span>
                    <FinanceActions
                      financeId={f.id}
                      conversationId={f.conversationId}
                      status={f.status}
                      notes={f.notes}
                      locationId={locationId || f.locationId || ''}
                      onUpdated={() => void reload()}
                    />
                  </li>
                  );
                })}
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
                {data.trades.map((t) => {
                  const openTradeAdvisor = data.escalations.some(
                    (e) =>
                      e.reason === 'TRADE_ADVISOR' &&
                      e.status === 'OPEN' &&
                      e.conversationId === t.conversationId,
                  );
                  const tradeAdvisorEsc = data.escalations.find(
                    (e) =>
                      e.reason === 'TRADE_ADVISOR' &&
                      e.status === 'OPEN' &&
                      e.conversationId === t.conversationId,
                  );
                  return (
                  <li key={t.id} className="stack">
                    <span className="row">
                      <span>{[t.year, t.make, t.model].filter(Boolean).join(' ') || 'Vehicle'} {t.mileage ? `· ${t.mileage.toLocaleString()} mi` : ''} {t.customerName ? `· ${t.customerName}` : ''}</span>
                      <Badge tone={statusTone(t.status)}>{t.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                    </span>
                    <span className="row">{openTradeAdvisor && <Badge tone="warn">advisor handoff</Badge>}<span className="muted small">{ago(t.createdAt)}</span>{t.conversationId && <a className="small" href={`#/inbox?conversation=${t.conversationId}`}>Open inbox</a>}</span>
                    <TradeActions
                      tradeId={t.id}
                      tradeAdvisorEscalationId={tradeAdvisorEsc?.id ?? null}
                      onUpdated={() => void reload()}
                    />
                  </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/** Staff record an appraisal; managers issue an expiring offer (the only value customers see). */
function TradeActions(props: {
  tradeId: string;
  tradeAdvisorEscalationId: string | null;
  onUpdated: () => void;
}) {
  const { tradeId } = props;
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState('7');
  const [msg, setMsg] = useState<string | null>(null);
  const isManager = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(session.user?.role ?? '');
  const post = async (path: string, body: unknown, ok: string) => {
    setMsg(null);
    try {
      await api(`/ops/trades/${tradeId}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      setMsg(ok);
      props.onUpdated();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  const ackTradeAdvisor = async () => {
    if (!props.tradeAdvisorEscalationId) return;
    setMsg(null);
    try {
      await api(`/escalations/${props.tradeAdvisorEscalationId}/acknowledge`, { method: 'POST' });
      setMsg('Advisor handoff acknowledged');
      props.onUpdated();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  const n = Number(amount);
  return (
    <span className="stack small">
      {props.tradeAdvisorEscalationId && (
        <button type="button" className="btn btn--ghost" onClick={() => void ackTradeAdvisor()}>Acknowledge trade advisor handoff</button>
      )}
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
    </span>
  );
}
