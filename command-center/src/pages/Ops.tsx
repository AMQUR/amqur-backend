import { useCallback, useState } from 'react';
import { api, session } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Card, Empty, ErrorNote } from '../ui';

type Dead = { id: string; topic: string; attempts: number; lastError: string | null; createdAt: string; updatedAt: string };
type ReplayResult = { count: number };

export function Ops() {
  const dead = useAsync(() => api<Dead[]>('/ops/outbox/dead'), []);
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const role = session.user?.role ?? '';
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(role);
  const rows = dead.data ?? [];
  const allSelected = rows.length > 0 && picked.length === rows.length;

  const replayIds = useCallback(
    async (ids: string[]) => {
      if (!isAdmin || ids.length === 0) return;
      setBusy(true);
      setErr(null);
      setInfo(null);
      try {
        const res = await api<ReplayResult>('/ops/outbox/replay', {
          method: 'POST',
          body: JSON.stringify({ ids }),
        });
        setPicked((prev) => prev.filter((id) => !ids.includes(id)));
        await dead.reload();
        if (res.count === 0) {
          setErr('No events were requeued. They may have already been replayed or are no longer dead.');
        } else if (res.count < ids.length) {
          setInfo(
            `Requeued ${res.count} of ${ids.length} selected. Remaining IDs were not dead or belong to another tenant.`,
          );
        } else {
          setInfo(`Requeued ${res.count} event${res.count === 1 ? '' : 's'} for delivery retry (audited). Delivery is not guaranteed until the worker succeeds.`);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Replay failed');
      } finally {
        setBusy(false);
      }
    },
    [dead, isAdmin],
  );

  const toggleAll = () => {
    if (!isAdmin) return;
    setPicked(allSelected ? [] : rows.map((d) => d.id));
  };

  return (
    <div className="page">
      <h1>Delivery failures</h1>
      <p className="muted">
        Events that could not be delivered after retries (CRM, notifications). Nothing here was reported to customers as
        delivered. Replay requeues dead letters for the worker; fix the underlying integration issue first.
      </p>
      {!isAdmin && role && (
        <p className="muted small">Replay is limited to SUPER_ADMIN and ADMIN. You can view dead letters only.</p>
      )}
      <ErrorNote error={dead.error ?? err} />
      {info && !err && (
        <p className="muted small" role="status">
          {info}
        </p>
      )}
      <Card
        actions={
          isAdmin &&
          picked.length > 0 && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || dead.loading}
              onClick={() => void replayIds(picked)}
            >
              Replay selected ({picked.length})
            </button>
          )
        }
      >
        {dead.loading && !rows.length ? (
          <p className="muted">Loading…</p>
        ) : !rows.length ? (
          <Empty>No dead letters.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>
                  {isAdmin && (
                    <input
                      type="checkbox"
                      aria-label="Select all dead letters"
                      checked={allSelected}
                      disabled={busy}
                      onChange={toggleAll}
                    />
                  )}
                </th>
                <th>Topic</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th>Created</th>
                {isAdmin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${d.topic}`}
                      checked={picked.includes(d.id)}
                      disabled={!isAdmin || busy}
                      onChange={(e) =>
                        setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))
                      }
                    />
                  </td>
                  <td>{d.topic}</td>
                  <td>{d.attempts}</td>
                  <td className="small">{d.lastError ?? '—'}</td>
                  <td className="small">{fmtDate(d.createdAt)}</td>
                  {isAdmin && (
                    <td>
                      <button
                        type="button"
                        className="btn btn--ghost btn--tiny"
                        disabled={busy}
                        onClick={() => void replayIds([d.id])}
                      >
                        Replay
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
