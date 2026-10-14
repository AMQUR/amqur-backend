import { api } from '../api';
import { ago, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, statusTone } from '../ui';

type Q = {
  finance: Array<{ id: string; vehicleVin: string | null; downPayment: number | null; desiredPayment: number | null; creditLinkState: string; aprSource: string; status: string; createdAt: string; customerName: string | null }>;
  parts: Array<{ id: string; suspectedPart: string | null; partNumber: string | null; vin: string | null; vehicleYear: number | null; vehicleModel: string | null; status: string; installationRequested: boolean; createdAt: string; customerName: string | null }>;
  trades: Array<{ id: string; year: number | null; make: string | null; model: string | null; mileage: number | null; status: string; createdAt: string; customerName: string | null }>;
  escalations: Array<{ id: string; reason: string; urgency: string; status: string; notifiedAt: string | null; createdAt: string; conversationId: string | null }>;
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
          <Card title={`Trade-ins (${data.trades.length})`}>
            {!data.trades.length ? <Empty>None open.</Empty> : (
              <ul className="list">
                {data.trades.map((t) => (
                  <li key={t.id}>
                    <span>{[t.year, t.make, t.model].filter(Boolean).join(' ') || 'Vehicle'} {t.mileage ? `· ${t.mileage.toLocaleString()} mi` : ''} {t.customerName ? `· ${t.customerName}` : ''}</span>
                    <Badge tone={statusTone(t.status)}>{t.status}</Badge>
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
