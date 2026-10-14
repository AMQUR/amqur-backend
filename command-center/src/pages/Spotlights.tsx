import { useState } from 'react';
import { api, session } from '../api';
import { useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote } from '../ui';

type Sp = { id: string; kind: string; title: string; body: string; status: string; startsAt: string; endsAt: string; createdById: string | null; vehicleVin: string | null };

/** Dealer spotlights: staff draft → a different manager approves → shown verbatim, labeled. */
export function Spotlights({ locationId }: { locationId: string }) {
  const list = useAsync(() => api<Sp[]>(`/ops/spotlights${locationId ? `?locationId=${locationId}` : ''}`), [locationId]);
  const [f, setF] = useState({ kind: 'ANNOUNCEMENT', title: '', body: '', vehicleVin: '', source: '', disclaimer: '', linkUrl: '', days: '7' });
  const [err, setErr] = useState<string | null>(null);
  const isManager = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(session.user?.role ?? '');
  const reload = async () => list.setData(await api<Sp[]>(`/ops/spotlights${locationId ? `?locationId=${locationId}` : ''}`));
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    }
  };
  const submit = () =>
    run(() =>
      api(`/ops/locations/${locationId}/spotlights`, {
        method: 'POST',
        body: JSON.stringify({
          kind: f.kind,
          title: f.title,
          body: f.body,
          ...(f.vehicleVin ? { vehicleVin: f.vehicleVin } : {}),
          ...(f.source ? { source: f.source } : {}),
          ...(f.disclaimer ? { disclaimer: f.disclaimer } : {}),
          ...(f.linkUrl ? { linkUrl: f.linkUrl } : {}),
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + (Number(f.days) || 7) * 86_400_000).toISOString(),
        }),
      }),
    );
  if (!locationId) return <div className="page"><h1>Spotlights</h1><p>Select a rooftop.</p></div>;
  return (
    <div className="page">
      <h1>Spotlights</h1>
      <ErrorNote error={list.error ?? err} />
      <Card title="New spotlight (needs approval by a different manager)">
        <div className="stack">
          <label>Type
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              {['ANNOUNCEMENT', 'EVENT', 'VEHICLE', 'OFFER'].map((k) => <option key={k}>{k}</option>)}
            </select>
          </label>
          <label>Title<input value={f.title} maxLength={80} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label>Text (shown verbatim)<input value={f.body} maxLength={400} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
          {f.kind === 'VEHICLE' && <label>VIN (must be in this store’s inventory)<input value={f.vehicleVin} onChange={(e) => setF({ ...f, vehicleVin: e.target.value })} /></label>}
          {f.kind === 'OFFER' && (
            <>
              <label>Offer source<input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></label>
              <label>Disclaimer<input value={f.disclaimer} onChange={(e) => setF({ ...f, disclaimer: e.target.value })} /></label>
            </>
          )}
          <label>Link on your website (optional, https)<input value={f.linkUrl} onChange={(e) => setF({ ...f, linkUrl: e.target.value })} /></label>
          <label>Days to run<input inputMode="numeric" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></label>
          <button className="btn" disabled={!f.title || !f.body} onClick={() => void submit()}>Submit for approval</button>
        </div>
      </Card>
      <Card title="All spotlights">
        {!list.data?.length ? <Empty>None yet.</Empty> : (
          <ul className="list">
            {list.data.map((s) => (
              <li key={s.id}>
                <span>{s.kind} · {s.title} <span className="muted small">until {new Date(s.endsAt).toLocaleDateString()}</span></span>
                <span className="row">
                  <Badge tone={s.status === 'APPROVED' ? 'ok' : s.status === 'PENDING_APPROVAL' ? 'warn' : 'neutral'}>{s.status.toLowerCase()}</Badge>
                  {isManager && s.status === 'PENDING_APPROVAL' && s.createdById !== session.user?.id && (
                    <>
                      <button className="btn" onClick={() => void run(() => api(`/ops/spotlights/${s.id}/decision`, { method: 'POST', body: JSON.stringify({ approve: true }) }))}>Approve</button>
                      <button className="btn btn--ghost" onClick={() => void run(() => api(`/ops/spotlights/${s.id}/decision`, { method: 'POST', body: JSON.stringify({ approve: false }) }))}>Reject</button>
                    </>
                  )}
                  {isManager && s.status === 'APPROVED' && <button className="btn btn--ghost" onClick={() => void run(() => api(`/ops/spotlights/${s.id}/archive`, { method: 'POST' }))}>Archive</button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
