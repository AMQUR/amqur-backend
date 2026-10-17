import { useMemo, useState } from 'react';
import { api } from '../api';
import { ago, fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, statusTone } from '../ui';

const ACTIVE_STATUSES = ['OPEN', 'CONTACTED', 'QUALIFIED'] as const;
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

type LeadRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  score: number;
  stage: string;
  status: string;
  source: string;
  crmSyncStatus: string;
  crmLastError: string | null;
  assignedUserId: string | null;
  interestedVin: string | null;
  updatedAt: string;
  location: { id: string; name: string; slug: string } | null;
  conversation: {
    id: string;
    externalKey: string;
    lastActivityAt: string | null;
    channel: string;
  } | null;
};

function leadName(l: LeadRow) {
  return [l.firstName, l.lastName].filter(Boolean).join(' ') || 'Lead';
}

export function Leads({ locationId }: { locationId: string }) {
  const [status, setStatus] = useState<'' | ActiveStatus>('');
  const qs = status ? `?status=${status}` : '';
  const { data, error, reload } = useAsync(() => api<LeadRow[]>(`/leads${qs}`), [qs]);
  const rows = useMemo(() => {
    const list = data ?? [];
    const active = list.filter((l) =>
      ACTIVE_STATUSES.includes(l.status as ActiveStatus),
    );
    const scoped = locationId
      ? active.filter((l) => !l.location || l.location.id === locationId)
      : active;
    return scoped.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, [data, locationId]);

  const filtered = status
    ? rows.filter((l) => l.status === status)
    : rows;

  return (
    <div className="page">
      <h1>Leads</h1>
      <p className="muted">
        Open pipeline from <code>GET /leads</code>. CRM sync shows the real backend state only — nothing is marked synced unless the server says so.
      </p>
      <div className="row">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | ActiveStatus)}
          aria-label="Lead status filter"
        >
          <option value="">All active (OPEN · CONTACTED · QUALIFIED)</option>
          {ACTIVE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="btn btn--ghost" type="button" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      <ErrorNote error={error} />
      <Card title={`${filtered.length} lead${filtered.length === 1 ? '' : 's'}`}>
        {!filtered.length ? (
          <Empty>No active leads for this filter.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Contact</th>
                <th>Stage</th>
                <th>Status</th>
                <th>CRM sync</th>
                <th>Rooftop</th>
                <th>Assignee</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div>{leadName(l)}</div>
                    <div className="muted small">
                      {[l.phone, l.email].filter(Boolean).join(' · ') || 'No contact yet'}
                    </div>
                    {l.interestedVin && (
                      <div className="muted small">VIN {l.interestedVin}</div>
                    )}
                  </td>
                  <td>
                    <Badge tone={l.stage === 'HOT' ? 'bad' : l.stage === 'WARM' ? 'warn' : 'neutral'}>
                      {l.stage}
                    </Badge>
                    <span className="muted small"> · score {l.score}</span>
                  </td>
                  <td>
                    <Badge>{l.status}</Badge>
                  </td>
                  <td>
                    <Badge tone={statusTone(l.crmSyncStatus)}>{l.crmSyncStatus}</Badge>
                    {l.crmSyncStatus === 'FAILED' && l.crmLastError && (
                      <div className="muted small" title={l.crmLastError}>
                        {l.crmLastError.length > 48
                          ? `${l.crmLastError.slice(0, 48)}…`
                          : l.crmLastError}
                      </div>
                    )}
                  </td>
                  <td>{l.location?.name ?? '—'}</td>
                  <td>
                    {l.assignedUserId ? (
                      <code className="small">{l.assignedUserId}</code>
                    ) : (
                      <span className="muted small">Unassigned</span>
                    )}
                  </td>
                  <td className="muted small" title={fmtDate(l.updatedAt)}>
                    {ago(l.updatedAt)}
                  </td>
                  <td>
                    {l.conversation?.id ? (
                      <a href={`#/inbox?conversation=${l.conversation.id}`}>Conversation</a>
                    ) : (
                      <span className="muted small">No thread</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="muted small">
        Manual lead reassignment is not exposed by the API yet; assignee reflects round-robin or existing server data only.
      </p>
    </div>
  );
}
