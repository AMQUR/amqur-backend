import { useState } from 'react';
import { api, session } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Card, Empty, ErrorNote } from '../ui';

type Dead = { id: string; topic: string; attempts: number; lastError: string | null; createdAt: string; updatedAt: string };

export function Ops() {
  const dead = useAsync(() => api<Dead[]>('/ops/outbox/dead'), []);
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(session.user?.role ?? '');
  return (
    <div className="page">
      <h1>Delivery failures</h1>
      <p className="muted">Events that could not be delivered after retries (CRM, notifications). Nothing here was reported to customers as delivered.</p>
      <ErrorNote error={dead.error ?? err} />
      <Card actions={isAdmin && picked.length > 0 && <button className="btn btn--primary" onClick={async () => { try { await api('/ops/outbox/replay', { method: 'POST', body: JSON.stringify({ ids: picked }) }); setPicked([]); await dead.reload(); } catch (e) { setErr(String((e as Error).message)); } }}>Retry {picked.length}</button>}>
        {!dead.data?.length ? <Empty>No dead letters.</Empty> : (
          <table className="table">
            <thead><tr><th /><th>Topic</th><th>Attempts</th><th>Last error</th><th>Created</th></tr></thead>
            <tbody>
              {dead.data.map((d) => (
                <tr key={d.id}>
                  <td><input type="checkbox" aria-label={`Select ${d.topic}`} checked={picked.includes(d.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))} disabled={!isAdmin} /></td>
                  <td>{d.topic}</td><td>{d.attempts}</td><td className="small">{d.lastError}</td><td className="small">{fmtDate(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
