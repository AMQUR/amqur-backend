import { useState } from 'react';
import { api, session } from '../api';
import { ago, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, statusTone } from '../ui';

type Q = {
  finance: Array<{ id: string; vehicleVin: string | null; downPayment: number | null; desiredPayment: number | null; creditLinkState: string; aprSource: string; status: string; createdAt: string; customerName: string | null }>;
  parts: Array<{ id: string; suspectedPart: string | null; partNumber: string | null; vin: string | null; vehicleYear: number | null; vehicleModel: string | null; status: string; installationRequested: boolean; createdAt: string; customerName: string | null }>;
  trades: Array<{ id: string; year: number | null; make: string | null; model: string | null; mileage: number | null; status: string; createdAt: string; customerName: string | null }>;
  escalations: Array<{ id: string; reason: string; urgency: string; status: string; notifiedAt: string | null; createdAt: string; conversationId: string | null }>;
  quotes?: Array<{ id: string; vehicleLabel: string | null; vehicleVin: string; paymentMethod: string; registrationZip: string | null; status: string; missingInputs: string[]; estimateShown: { total?: number } | null; createdAt: string; customerName: string | null }>;
};

export function Queues({ locationId }: { locationId: string }) {
  const { data, error } = useAsync(() => api<Q>(`/ops/queues${locationId ? `?locationId=${locationId}` : ''}`), [locationId]);
  return (
    <div className="page">
      <h1>Work queues</h1>
      <ErrorNote error={error} />
      {data && (
        <div className="grid2">
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
                  <li key={f.id}>
                    <span>{f.customerName ?? 'Visitor'} · {f.vehicleVin ?? 'no vehicle'} {f.downPayment ? `· $${f.downPayment.toLocaleString()} down` : ''} {f.desiredPayment ? `· target $${f.desiredPayment}/mo` : ''}</span>
                    <span className="row"><Badge tone={statusTone(f.creditLinkState)}>credit {f.creditLinkState.toLowerCase()}</Badge><span className="muted small">{ago(f.createdAt)}</span></span>
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
