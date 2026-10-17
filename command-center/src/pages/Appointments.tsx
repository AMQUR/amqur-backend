import { useState } from 'react';
import { api } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, Stat, statusTone } from '../ui';

type Outcomes = {
  window: string;
  counts: {
    completed: number;
    noShow: number;
    confirmedOnBook: number;
    awaitingConfirmation: number;
    cancelled: number;
  };
  showRate: number | null;
  note: string;
};

type Appt = { id: string; type: string; status: string; requestedDate: string | null; requestedTime: string | null; requestedAt: string | null; scheduledAt: string | null; provider: string; availabilityVerified: boolean; customerName: string | null; customerPhone: string | null; customerEmail: string | null; vehicleVin: string | null; serviceType: string | null; transportation: string | null; timezone: string };

export function Appointments({ locationId }: { locationId: string }) {
  const [status, setStatus] = useState('');
  const qs = new URLSearchParams({ ...(locationId ? { locationId } : {}), ...(status ? { status } : {}) }).toString();
  const locQ = locationId ? `?locationId=${locationId}` : '';
  const { data, error, reload } = useAsync(() => api<Appt[]>(`/appointments?${qs}`), [qs]);
  const outcomes = useAsync(() => api<Outcomes>(`/ops/appointment-outcomes${locQ}`), [locQ]);
  const [err, setErr] = useState<string | null>(null);
  const act = async (id: string, to: string, extra: Record<string, string> = {}) => {
    setErr(null);
    try {
      await api(`/appointments/${id}/transition`, { method: 'POST', body: JSON.stringify({ to, ...extra }) });
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    }
  };
  return (
    <div className="page">
      <h1>Appointments</h1>
      <p className="muted">
        <Badge>REQUEST</Badge> = customer preference captured by AMQUR, not yet booked. <Badge tone="ok">CONFIRMED</Badge> = confirmed by staff or the dealership scheduler.
      </p>
      <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
        <option value="">All statuses</option>
        {['REQUESTED', 'PENDING_CONFIRMATION', 'CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'].map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <ErrorNote error={error ?? err ?? outcomes.error} />
      {outcomes.data && (
        <Card title="Visit outcomes · 7 days">
          <div className="stats">
            <Stat label="Completed" value={outcomes.data.counts.completed} hint="staff-recorded" />
            <Stat label="No-show" value={outcomes.data.counts.noShow} hint="staff-recorded" />
            <Stat
              label="Show rate"
              value={
                outcomes.data.showRate != null
                  ? `${Math.round(outcomes.data.showRate * 100)}%`
                  : '—'
              }
              hint={
                outcomes.data.showRate != null
                  ? 'completed ÷ (completed + no-show)'
                  : 'mark visits Completed or No-show'
              }
            />
            <Stat label="Confirmed on book" value={outcomes.data.counts.confirmedOnBook} />
            <Stat label="Awaiting confirm" value={outcomes.data.counts.awaitingConfirmation} />
            <Stat label="Cancelled" value={outcomes.data.counts.cancelled} hint="7d" />
          </div>
          <p className="muted small">{outcomes.data.note}</p>
        </Card>
      )}
      <Card>
        {!data?.length ? (
          <Empty>No appointments.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When (dealership time)</th><th>Type</th><th>Customer</th><th>Vehicle / need</th><th>Status</th><th>Source</th><th />
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>{a.scheduledAt ? fmtDate(a.scheduledAt) : `${a.requestedDate ?? ''} ${a.requestedTime ?? ''}`}</td>
                  <td>{a.type}</td>
                  <td>{a.customerName ?? '—'}<div className="muted small">{a.customerPhone ?? a.customerEmail ?? ''}</div></td>
                  <td className="small">{a.vehicleVin ?? a.serviceType ?? '—'}{a.transportation && <div className="muted">{a.transportation}</div>}</td>
                  <td><Badge tone={statusTone(a.status)}>{a.status === 'REQUESTED' ? 'REQUEST' : a.status}</Badge></td>
                  <td className="small">{a.provider === 'NONE' ? 'AMQUR request' : a.provider}</td>
                  <td className="row">
                    {['REQUESTED', 'PENDING_CONFIRMATION'].includes(a.status) && (
                      <button className="btn btn--primary" onClick={() => {
                        const at = window.prompt('Confirmed date/time (ISO, dealership local converted by browser), e.g. 2026-10-17T15:00', a.requestedAt ? a.requestedAt.slice(0, 16) : '');
                        if (at) void act(a.id, 'CONFIRMED', { scheduledAt: new Date(at).toISOString(), note: 'confirmed with customer' });
                      }}>Confirm</button>
                    )}
                    {a.status === 'CONFIRMED' && (
                      <>
                        <button className="btn" onClick={() => void act(a.id, 'COMPLETED')}>Completed</button>
                        <button className="btn" onClick={() => void act(a.id, 'NO_SHOW')}>No-show</button>
                      </>
                    )}
                    {['REQUESTED', 'PENDING_CONFIRMATION', 'CONFIRMED'].includes(a.status) && (
                      <button className="btn btn--ghost" onClick={() => void act(a.id, 'CANCELLED', { note: 'staff' })}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
