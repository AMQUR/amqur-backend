import { useState } from 'react';
import { api, session } from '../api';
import { ago, fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote } from '../ui';
import {
  STATUS_FILTERS,
  TOOLS_BASE,
  actionTone,
  capability,
  decisionBody,
  expiryText,
  inputEntries,
  listPath,
  riskTone,
  statusLabel,
  type ToolActionRow,
  type ToolActionStatus,
  type ToolCatalog,
} from '../tools/toolActions';

/**
 * Staff approval inbox for typed tool actions. Approving echoes the checksum of the exact
 * (redacted) request the reviewer saw; the server recomputes and rejects a mismatch. Execution
 * is a mock only, and nothing runs unless the server-side flags allow it.
 */
export function ToolApprovals({ locationId }: { locationId: string }) {
  const [filter, setFilter] = useState<ToolActionStatus | 'ALL'>('PENDING_APPROVAL');
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const catalog = useAsync(() => api<ToolCatalog>(`${TOOLS_BASE}/catalog`), []);
  const list = useAsync(() => api<ToolActionRow[]>(listPath(filter)), [filter]);
  const user = session.user;
  const rows = (list.data ?? []).filter((r) => !locationId || r.locationId === locationId);

  async function act(row: ToolActionRow, fn: () => Promise<unknown>, done: string) {
    setBusy(row.id);
    setMessage(null);
    setActionError(null);
    try {
      await fn();
      setMessage(done);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(null);
      void list.reload();
    }
  }

  return (
    <div className="page">
      <h1>Action approvals</h1>
      <ErrorNote error={catalog.error ?? list.error} />
      {catalog.data && !catalog.data.enabled && (
        <p className="muted" role="status">
          Tool actions are switched off for this deployment. You can review history, but nothing can be proposed or decided.
        </p>
      )}
      {catalog.data?.enabled && (
        <p className="muted small" role="status">
          Provider mode: {catalog.data.providerMode}. {catalog.data.dispatchEnabled ? 'Approved actions run against a mock executor only.' : 'Dispatch is off: approving records the decision but nothing runs.'}
        </p>
      )}
      <div className="row" role="group" aria-label="Filter by status">
        {STATUS_FILTERS.map((f) => (
          <button key={f.id} className={f.id === filter ? 'btn' : 'btn btn--ghost'} aria-pressed={f.id === filter} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {message && <p role="status">{message}</p>}
      <ErrorNote error={actionError} />
      {list.loading && !list.data ? <p aria-busy="true">Loading…</p> : !rows.length ? (
        <Empty>Nothing here.</Empty>
      ) : (
        <div className="stack">
          {rows.map((r) => {
            const tool = catalog.data?.tools.find((t) => t.name === r.toolName);
            const cap = user ? capability(r, tool, user) : { canDecide: false, canCancel: false, reason: 'Not signed in' };
            const busyHere = busy === r.id;
            return (
              <Card
                key={r.id}
                title={<>{r.toolName} <span className="muted small">v{String(r.toolVersion)}</span></>}
                actions={<span className="row">{tool && <Badge tone={riskTone(tool.risk)}>{tool.risk.toLowerCase()} risk</Badge>}<Badge tone={actionTone(r.status)}>{statusLabel(r.status)}</Badge></span>}
              >
                {tool && <p className="muted small">{tool.description}</p>}
                <dl className="small">
                  {inputEntries(r.input).map(([k, v]) => (
                    <div key={k}><dt className="muted">{k}</dt><dd>{v}</dd></div>
                  ))}
                </dl>
                <p className="muted small">
                  Requested {ago(r.createdAt)} {expiryText(r) && `· ${expiryText(r)}`}
                  {tool?.requiresCustomerConsent && ` · consent ref: ${r.consentRef ?? 'none'}`}
                  {r.decidedAt && ` · decided ${fmtDate(r.decidedAt)}`}
                  {r.decisionNote && ` · “${r.decisionNote}”`}
                  {r.failureReason && ` · failure: ${r.failureReason}`}
                </p>
                <p className="muted small">Review code <code>{r.checksum.slice(0, 12)}…</code> (bound to exactly what is shown above)</p>
                {r.status === 'PENDING_APPROVAL' && (
                  <div className="stack">
                    {!cap.canDecide && cap.reason && <p className="muted small">{cap.reason}</p>}
                    {cap.canDecide && (
                      <label className="small">
                        Note (optional)
                        <input maxLength={300} value={note[r.id] ?? ''} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} />
                      </label>
                    )}
                    <span className="row">
                      {cap.canDecide && (
                        <>
                          <button className="btn" disabled={busyHere} onClick={() => void act(r, () => api(`${TOOLS_BASE}/actions/${r.id}/decision`, { method: 'POST', body: JSON.stringify(decisionBody(r, 'APPROVE', note[r.id])) }), 'Approved')}>Approve</button>
                          <button className="btn btn--ghost" disabled={busyHere} onClick={() => void act(r, () => api(`${TOOLS_BASE}/actions/${r.id}/decision`, { method: 'POST', body: JSON.stringify(decisionBody(r, 'DENY', note[r.id])) }), 'Denied')}>Deny</button>
                        </>
                      )}
                      {cap.canCancel && (
                        <button className="btn btn--ghost" disabled={busyHere} onClick={() => void act(r, () => api(`${TOOLS_BASE}/actions/${r.id}/cancel`, { method: 'POST' }), 'Cancelled')}>Cancel request</button>
                      )}
                    </span>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
