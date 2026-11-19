import { useState } from 'react';
import { api, session } from '../api';
import { ago, fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote } from '../ui';
import {
  DELIVERIES_BASE,
  LADDER,
  actorLabel,
  STATUS_FILTERS,
  blockedReasonText,
  capability,
  listPath,
  reconcileBody,
  routeReadiness,
  statusSummary,
  statusTone,
  tally,
  type LeadDeliveryEvent,
  type LeadDeliveryRoute,
  type LeadDeliveryRow,
  type LeadDeliveryStatus,
  deliveryModeLabel,
} from '../deliveries/leadDeliveries';

/**
 * Lead delivery ledger: where each lead is on its way to the rooftop's CRM, and on what
 * evidence. No customer contact details and no destination addresses are shown here.
 */
export function LeadDeliveries({ locationId }: { locationId: string }) {
  const [filter, setFilter] = useState<LeadDeliveryStatus | 'ALL'>('ALL');
  const [openId, setOpenId] = useState<string | null>(null);
  const [crmRef, setCrmRef] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const role = session.user?.role ?? '';
  const canSeeRoutes = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(role);
  const list = useAsync(() => api<LeadDeliveryRow[]>(listPath(filter, locationId || undefined)), [filter, locationId]);
  const routes = useAsync(
    () => (canSeeRoutes ? api<LeadDeliveryRoute[]>(`/ops/lead-delivery-routes${locationId ? `?locationId=${encodeURIComponent(locationId)}` : ''}`) : Promise.resolve([])),
    [locationId, canSeeRoutes],
  );
  const detail = useAsync(() => (openId ? api<LeadDeliveryRow & { events: LeadDeliveryEvent[] }>(`${DELIVERIES_BASE}/${openId}`) : Promise.resolve(null)), [openId]);
  const rows = list.data ?? [];
  const counts = tally(rows);

  async function act(id: string, fn: () => Promise<unknown>, done: string) {
    setBusy(id);
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
      if (openId === id) void detail.reload();
    }
  }

  return (
    <div className="page">
      <h1>Lead deliveries</h1>
      <p className="muted">
        Each lead is sent to its own rooftop’s CRM inbox as ADF. A lead counts as in the CRM only once it is matched to a CRM record.
      </p>
      <ErrorNote error={list.error ?? routes.error} />

      <dl className="row" aria-label="Summary for this list">
        <div><dt className="muted small">Shown</dt><dd>{counts.total}</dd></div>
        <div><dt className="muted small">Confirmed in CRM</dt><dd>{counts.inCrm}</dd></div>
        <div><dt className="muted small">Sent, not confirmed</dt><dd>{counts.unconfirmed}</dd></div>
        <div><dt className="muted small">Need attention</dt><dd>{counts.attention}</dd></div>
      </dl>

      {canSeeRoutes && (
        <Card title="Destinations">
          {!routes.data?.length ? (
            <p className="muted small">No destination is set up{locationId ? ' for this rooftop' : ''}. Leads stay in AMQUR and are marked as not sent.</p>
          ) : (
            <table className="small">
              <thead><tr><th scope="col">Department</th><th scope="col">Destination</th><th scope="col">Format</th><th scope="col">Readiness</th></tr></thead>
              <tbody>
                {routes.data.map((r) => {
                  const ready = routeReadiness(r);
                  return (
                    <tr key={r.id}>
                      <td>{r.department.toLowerCase()}</td>
                      <td><code>{r.destinationMasked ?? 'hidden'}</code></td>
                      <td>{r.format}</td>
                      <td><Badge tone={ready.tone}>{ready.label}</Badge>{r.verifiedAt && <span className="muted"> · verified {fmtDate(r.verifiedAt)}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
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
        <Empty>No lead deliveries here.</Empty>
      ) : (
        <div className="stack">
          {rows.map((r) => {
            const cap = capability(r, role);
            const open = openId === r.id;
            const busyHere = busy === r.id;
            return (
              <Card
                key={r.id}
                title={<>{r.department.toLowerCase()} lead <span className="muted small">· {r.channel.replace('_', ' ').toLowerCase()} · queued {ago(r.createdAt)}</span></>}
                actions={<Badge tone={statusTone(r.status)}>{statusSummary(r.status)}</Badge>}
              >
                <ol className="ladder small" aria-label="Delivery progress">
                  {LADDER.map((step) => {
                    const at = r[step.at] as string | null;
                    return (
                      <li key={step.status} title={step.evidence} aria-current={r.status === step.status ? 'step' : undefined}>
                        <span className={at ? '' : 'muted'}>{at ? '●' : '○'} {step.label}</span>
                        {at && <span className="muted"> {fmtDate(at)}</span>}
                      </li>
                    );
                  })}
                </ol>
                <p className="muted small">
                  To <code>{r.destinationMasked ?? 'no destination'}</code>
                  {r.providerName && ` · via ${r.providerName}`}
                  {deliveryModeLabel(r.deliveryMode) && ` · ${deliveryModeLabel(r.deliveryMode)}`}
                  {r.providerMessageId && ` · message id ${r.providerMessageId.slice(0, 40)}`}
                  {r.crmRecordRef && ` · CRM record ${r.crmRecordRef}`}
                  {` · attempts ${r.attempts}`}
                  {r.replayCount > 0 && ` · replayed ${r.replayCount}×`}
                </p>
                {r.status === 'BLOCKED' && <p className="small">Why it was not sent: {blockedReasonText(r.blockedReason)}</p>}
                {(r.status === 'FAILED' || r.status === 'DEAD') && r.lastErrorCode && <p className="small">Last error: <code>{r.lastErrorCode}</code></p>}
                {r.status === 'CRM_REJECTED' && <p className="small">The CRM did not accept this lead. Contact the customer from the lead record and enter the lead in the CRM by hand.</p>}

                <span className="row">
                  <button className="btn btn--ghost" aria-expanded={open} onClick={() => setOpenId(open ? null : r.id)}>{open ? 'Hide history' : 'History'}</button>
                  {cap.canReplay && (
                    <button className="btn" disabled={busyHere} onClick={() => void act(r.id, () => api(`${DELIVERIES_BASE}/${r.id}/replay`, { method: 'POST' }), 'Queued to send again')}>
                      Send again
                    </button>
                  )}
                </span>

                {cap.canReconcile && (
                  <div className="stack">
                    <label className="small">
                      CRM record reference (needed to mark as in CRM)
                      <input maxLength={128} value={crmRef[r.id] ?? ''} onChange={(e) => setCrmRef({ ...crmRef, [r.id]: e.target.value })} />
                    </label>
                    <span className="row">
                      <button
                        className="btn"
                        disabled={busyHere || !(crmRef[r.id] ?? '').trim()}
                        onClick={() => void act(r.id, () => api(`${DELIVERIES_BASE}/${r.id}/reconcile`, { method: 'POST', body: JSON.stringify(reconcileBody('CRM_MATCHED', crmRef[r.id])) }), 'Marked as in CRM')}
                      >
                        Found in CRM
                      </button>
                      <button className="btn btn--ghost" disabled={busyHere} onClick={() => void act(r.id, () => api(`${DELIVERIES_BASE}/${r.id}/reconcile`, { method: 'POST', body: JSON.stringify(reconcileBody('CRM_REJECTED')) }), 'Marked as rejected by CRM')}>
                        Not in CRM / rejected
                      </button>
                    </span>
                  </div>
                )}

                {open && (
                  <div>
                    <ErrorNote error={detail.error} />
                    {detail.loading && !detail.data ? <p aria-busy="true">Loading…</p> : (
                      <ol className="small">
                        {(detail.data?.events ?? []).map((ev) => (
                          <li key={ev.id}>
                            {fmtDate(ev.createdAt)} — {ev.fromStatus ? `${ev.fromStatus} → ` : ''}{ev.toStatus}
                            {ev.reasonCode && <span className="muted"> · {ev.reasonCode}</span>}
                            <span className="muted"> · {actorLabel(ev.actor)}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    {r.correlationId && <p className="muted small">Trace <code>{r.correlationId}</code></p>}
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
