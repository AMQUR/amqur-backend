import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Badge, Card, ErrorNote } from '../ui';

type Campaign = {
  id: string;
  name: string;
  trigger: string;
  channel: string;
  enabled: boolean;
  version: number;
  template: string | null;
};

type Preview = {
  dryRun: true;
  wouldSend: false;
  automationEnabled: boolean;
  enabled: boolean;
  totals: { candidates: number; eligible: number; ineligible: number };
  reasons: Record<string, number>;
  sample: Array<{
    subjectId: string;
    eligible: boolean;
    reason: string | null;
    maskedEndpoint: string | null;
  }>;
  note: string;
};

type Analytics = {
  queued: number;
  suppressed: number;
  customerReplies: number;
  bookingIntentReplies: number;
  suppressReasons: Record<string, number>;
  windowDays: number;
  note?: string;
};

export function Campaigns({ locationId }: { locationId: string }) {
  void locationId;
  const list = useAsync(() => api<Campaign[]>('/campaigns'), []);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const runPreview = async (id: string) => {
    setErr(null);
    setBusy(id);
    setPreview(null);
    setAnalytics(null);
    try {
      const [p, a] = await Promise.all([
        api<Preview>(`/campaigns/${id}/preview`, { method: 'POST', body: '{}' }),
        api<Analytics>(`/campaigns/${id}/analytics`),
      ]);
      setPreview(p);
      setAnalytics(a);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <h1>Follow-up campaigns</h1>
      <p className="muted">
        Dry-run preview only. Enabling live sends still requires consent, quiet hours,{' '}
        <code>automatedFollowup</code>, and owner authorization. Mass marketing remains gated.
      </p>
      <ErrorNote error={list.error ?? err} />
      <Card title="Campaigns">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Trigger</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name} <span className="muted small">v{c.version}</span>
                </td>
                <td>
                  <code>{c.trigger}</code>
                </td>
                <td>
                  <Badge tone={c.enabled ? 'ok' : 'neutral'}>
                    {c.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </td>
                <td>
                  <button
                    className="btn btn--ghost"
                    disabled={busy === c.id}
                    onClick={() => void runPreview(c.id)}
                  >
                    {busy === c.id ? 'Running…' : 'Dry-run preview'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(list.data ?? []).length === 0 && (
          <p className="muted">No campaigns configured yet.</p>
        )}
      </Card>
      {preview && (
        <Card title="Audience preview (no send)">
          <div className="stats">
            <span>
              Candidates <strong>{preview.totals.candidates}</strong>
            </span>
            <span>
              Eligible <strong>{preview.totals.eligible}</strong>
            </span>
            <span>
              Ineligible <strong>{preview.totals.ineligible}</strong>
            </span>
          </div>
          <p className="muted small">{preview.note}</p>
          <ul className="kv">
            <li>
              <span>Automation flag</span>
              <Badge tone={preview.automationEnabled ? 'ok' : 'warn'}>
                {preview.automationEnabled ? 'on' : 'off'}
              </Badge>
            </li>
            <li>
              <span>Campaign enabled</span>
              <Badge tone={preview.enabled ? 'ok' : 'neutral'}>
                {preview.enabled ? 'yes' : 'no'}
              </Badge>
            </li>
          </ul>
          {Object.keys(preview.reasons).length > 0 && (
            <p className="small">
              Stop reasons:{' '}
              {Object.entries(preview.reasons)
                .map(([k, v]) => `${k} (${v})`)
                .join(', ')}
            </p>
          )}
        </Card>
      )}
      {analytics && (
        <Card title={`Step analytics · ${analytics.windowDays}d`}>
          <div className="stats">
            <span>
              Queued <strong>{analytics.queued}</strong>
            </span>
            <span>
              Suppressed <strong>{analytics.suppressed}</strong>
            </span>
            <span>
              Replies <strong>{analytics.customerReplies ?? 0}</strong>
            </span>
            <span>
              Booking intent <strong>{analytics.bookingIntentReplies ?? 0}</strong>
            </span>
          </div>
          {analytics.note && <p className="muted small">{analytics.note}</p>}
          {Object.keys(analytics.suppressReasons ?? {}).length > 0 && (
            <p className="small">
              Suppress reasons:{' '}
              {Object.entries(analytics.suppressReasons)
                .map(([k, v]) => `${k} (${v})`)
                .join(', ')}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
