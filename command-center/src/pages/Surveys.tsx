import { useState } from 'react';
import { api } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, Stat, statusTone } from '../ui';

type Survey = {
  id: string;
  channel: string;
  status: string;
  score: number | null;
  comment: string | null;
  leadId: string | null;
  conversationId: string | null;
  createdAt: string;
  respondedAt: string | null;
};

type Rollup = {
  windowDays: number;
  draftsOpen: number;
  respondedCount: number;
  averageScore: number | null;
  note: string;
};

export function Surveys({ locationId }: { locationId: string }) {
  const qs = locationId ? `?locationId=${encodeURIComponent(locationId)}` : '';
  const list = useAsync(() => api<Survey[]>(`/ops/surveys${qs}`), [qs]);
  const rollup = useAsync(() => api<Rollup>(`/ops/surveys/rollup${qs}`), [qs]);
  const [leadId, setLeadId] = useState('');
  const [channel, setChannel] = useState('LINK');
  const [scoreById, setScoreById] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    await Promise.all([list.reload(), rollup.reload()]);
  };

  const createDraft = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api('/ops/surveys', {
        method: 'POST',
        body: JSON.stringify({
          ...(locationId ? { locationId } : {}),
          ...(leadId.trim() ? { leadId: leadId.trim() } : {}),
          channel,
        }),
      });
      setLeadId('');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  const record = async (id: string) => {
    const score = Number(scoreById[id]);
    if (!Number.isInteger(score) || score < 1 || score > 10) {
      setErr('Score must be an integer from 1 to 10');
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await api(`/ops/surveys/${id}/response`, {
        method: 'POST',
        body: JSON.stringify({ score }),
      });
      setScoreById((m) => ({ ...m, [id]: '' }));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Record failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>CSI surveys</h1>
      <p className="muted">
        Staff-recorded customer satisfaction only. Creating a draft does not send SMS or email.
        Mass survey outreach stays gated.
      </p>
      <ErrorNote error={err ?? list.error ?? rollup.error} />
      {rollup.data && (
        <div className="stats">
          <Stat label="Drafts open" value={rollup.data.draftsOpen} />
          <Stat
            label="Responses"
            value={rollup.data.respondedCount}
            hint={`${rollup.data.windowDays}d window`}
          />
          <Stat
            label="Average score"
            value={rollup.data.averageScore ?? '—'}
            hint="1–10 scale"
          />
        </div>
      )}
      {rollup.data?.note && <p className="muted small">{rollup.data.note}</p>}

      <Card title="New CSI draft">
        <div className="row">
          <label className="small">
            Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="LINK">LINK</option>
              <option value="IN_PERSON">IN_PERSON</option>
              <option value="EMAIL">EMAIL</option>
              <option value="SMS">SMS (record only — no send)</option>
            </select>
          </label>
          <label className="small">
            Lead id (optional)
            <input
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
              placeholder="lead cuid"
            />
          </label>
          <button className="btn btn--primary" disabled={busy} onClick={() => void createDraft()}>
            Create draft
          </button>
        </div>
      </Card>

      <Card title="Surveys">
        {!list.data?.length && !list.loading ? <Empty>No surveys yet.</Empty> : null}
        <ul className="list">
          {(list.data ?? []).map((s) => (
            <li key={s.id} className="stack">
              <span className="row between">
                <span>
                  <Badge tone={statusTone(s.status)}>{s.status}</Badge>{' '}
                  <Badge tone="neutral">{s.channel}</Badge>
                  {s.score != null && <Badge tone="ok">{s.score}/10</Badge>}
                </span>
                <span className="muted small">{fmtDate(s.createdAt)}</span>
              </span>
              {s.leadId && <span className="muted small">Lead {s.leadId}</span>}
              {s.comment && <span className="small">{s.comment}</span>}
              {s.status !== 'RESPONDED' && s.status !== 'CANCELLED' && (
                <span className="row">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    placeholder="Score 1–10"
                    value={scoreById[s.id] ?? ''}
                    onChange={(e) =>
                      setScoreById((m) => ({ ...m, [s.id]: e.target.value }))
                    }
                  />
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void record(s.id)}
                  >
                    Record response
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
