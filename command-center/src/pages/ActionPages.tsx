import { useState } from 'react';
import { api } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Badge, Card, ErrorNote } from '../ui';

const KINDS = [
  'SCHEDULE',
  'TRADE_INTAKE',
  'PARTS_INTAKE',
  'DOCUMENT_UPLOAD',
  'FINANCE_INFO',
  'CONTACT_UPDATE',
  'CUSTOM',
] as const;

type ActionPageKind = (typeof KINDS)[number];

type ActionPageRow = {
  id: string;
  kind: string;
  title: string;
  status: string;
  leadId: string | null;
  locationId: string | null;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
};

type CreateResponse = {
  page: ActionPageRow;
  token: string;
};

export function ActionPages({ locationId }: { locationId: string }) {
  const list = useAsync(() => api<ActionPageRow[]>('/action-pages'), []);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [form, setForm] = useState<{
    kind: ActionPageKind;
    title: string;
    description: string;
  }>({
    kind: 'SCHEDULE',
    title: '',
    description: '',
  });

  const create = async () => {
    setErr(null);
    setCreatedToken(null);
    setBusy(true);
    try {
      const body: Record<string, string> = {
        kind: form.kind,
        title: form.title.trim(),
      };
      if (form.description.trim()) body.description = form.description.trim();
      if (locationId) body.locationId = locationId;
      const r = await api<CreateResponse>('/action-pages', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setCreatedToken(r.token);
      setForm({ kind: form.kind, title: '', description: '' });
      await list.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>Customer action pages</h1>
      <p className="muted">
        One-time links for scheduling, trade intake, document upload, and other structured customer
        tasks. Share the token URL only over a verified channel.
      </p>
      <ErrorNote error={list.error ?? err} />
      {createdToken && (
        <p className="banner banner--warn" role="status">
          <strong>One-time link token</strong> — copy now; it will not be shown again.
          <br />
          <code style={{ wordBreak: 'break-all' }}>{createdToken}</code>
        </p>
      )}
      <Card title="Create action page">
        <div className="stack">
          <div className="grid2">
            <label>
              Kind
              <select
                value={form.kind}
                onChange={(e) =>
                  setForm({ ...form, kind: e.target.value as ActionPageKind })
                }
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Title
              <input
                required
                minLength={2}
                maxLength={120}
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Upload your driver's license"
              />
            </label>
          </div>
          <label>
            Description <span className="muted small">(optional)</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Short instructions for the customer"
            />
          </label>
          {locationId ? (
            <p className="muted small">Scoped to the selected rooftop.</p>
          ) : (
            <p className="muted small">No rooftop selected — page is tenant-wide.</p>
          )}
          <button
            className="btn btn--primary"
            disabled={busy || form.title.trim().length < 2}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create action page'}
          </button>
        </div>
      </Card>
      <Card title="Recent action pages">
        {list.loading && <p className="muted">Loading…</p>}
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Expires</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((p) => (
              <tr key={p.id}>
                <td>{p.title}</td>
                <td>
                  <code>{p.kind}</code>
                </td>
                <td>
                  <Badge tone={statusTone(p.status)}>{p.status.replace(/_/g, ' ')}</Badge>
                </td>
                <td className="small">{fmtDate(p.expiresAt)}</td>
                <td className="small">{fmtDate(p.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.loading && (list.data ?? []).length === 0 && (
          <p className="muted">No action pages yet.</p>
        )}
      </Card>
    </div>
  );
}

function statusTone(s: string): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' {
  if (/COMPLETED|PUBLISHED|ACTIVE/i.test(s)) return 'ok';
  if (/REVOKED|EXPIRED|CANCEL/i.test(s)) return 'bad';
  if (/PENDING|DRAFT/i.test(s)) return 'warn';
  return 'neutral';
}
