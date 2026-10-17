import { useState } from 'react';
import { api } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, Stat, statusTone } from '../ui';

type Survey = {
  id: string;
  kind: string;
  channel: string;
  status: string;
  score: number | null;
  comment: string | null;
  leadId: string | null;
  conversationId: string | null;
  followUpStatus?: string;
  followUpRequired?: boolean;
  createdAt: string;
  respondedAt: string | null;
  template?: { id: string; name: string; kind: string } | null;
};

type Rollup = {
  windowDays: number;
  draftsOpen: number;
  respondedCount: number;
  averageScore: number | null;
  followUpsOpen?: number;
  byKind?: {
    sales: { count: number; average: number | null };
    service: { count: number; average: number | null };
  };
  note: string;
};

type Template = {
  id: string;
  name: string;
  kind: string;
  scriptBody: string;
  defaultChannel: string;
};

export function Surveys({ locationId }: { locationId: string }) {
  const qs = locationId ? `?locationId=${encodeURIComponent(locationId)}` : '';
  const [kindFilter, setKindFilter] = useState<'ALL' | 'SALES' | 'SERVICE'>('ALL');
  const listQs = `${qs}${kindFilter !== 'ALL' ? `${qs ? '&' : '?'}kind=${kindFilter}` : ''}`;
  const list = useAsync(() => api<Survey[]>(`/ops/surveys${listQs || ''}`), [listQs]);
  const rollup = useAsync(() => api<Rollup>(`/ops/surveys/rollup${qs}`), [qs]);
  const followUps = useAsync(() => api<Survey[]>(`/ops/surveys/follow-ups${qs}`), [qs]);
  const templates = useAsync(() => api<Template[]>(`/ops/surveys/templates${qs}`), [qs]);
  const [leadId, setLeadId] = useState('');
  const [kind, setKind] = useState('SALES');
  const [channel, setChannel] = useState('IN_PERSON');
  const [templateId, setTemplateId] = useState('');
  const [scoreById, setScoreById] = useState<Record<string, string>>({});
  const [commentById, setCommentById] = useState<Record<string, string>>({});
  const [tplName, setTplName] = useState('');
  const [tplScript, setTplScript] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    await Promise.all([list.reload(), rollup.reload(), followUps.reload(), templates.reload()]);
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
          ...(templateId ? { templateId } : {}),
          kind,
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

  const createTemplate = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api('/ops/surveys/templates', {
        method: 'POST',
        body: JSON.stringify({
          name: tplName,
          scriptBody: tplScript,
          kind,
          defaultChannel: channel,
          ...(locationId ? { locationId } : {}),
        }),
      });
      setTplName('');
      setTplScript('');
      await templates.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Template create failed');
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
        body: JSON.stringify({
          score,
          ...(commentById[id]?.trim() ? { comment: commentById[id].trim() } : {}),
        }),
      });
      setScoreById((m) => ({ ...m, [id]: '' }));
      setCommentById((m) => ({ ...m, [id]: '' }));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Record failed');
    } finally {
      setBusy(false);
    }
  };

  const ack = async (id: string) => {
    setBusy(true);
    try {
      await api(`/ops/surveys/${id}/follow-up/acknowledge`, { method: 'POST' });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Acknowledge failed');
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (id: string) => {
    const note = window.prompt('Manager resolution note (optional)') ?? '';
    setBusy(true);
    try {
      await api(`/ops/surveys/${id}/follow-up/resolve`, {
        method: 'POST',
        body: JSON.stringify({ ...(note.trim() ? { managerNote: note.trim() } : {}) }),
      });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Resolve failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>CSI surveys</h1>
      <p className="muted">
        Internal staff-recorded customer satisfaction (sales and service). Creating a draft does not
        send SMS or email. Scores are not OEM manufacturer CSI. Mass survey outreach stays gated.
      </p>
      <ErrorNote error={err ?? list.error ?? rollup.error ?? followUps.error} />
      {rollup.data && (
        <div className="stats">
          <Stat label="Drafts open" value={rollup.data.draftsOpen} />
          <Stat
            label="Responses"
            value={rollup.data.respondedCount}
            hint={`${rollup.data.windowDays}d window`}
          />
          <Stat label="Average" value={rollup.data.averageScore ?? '—'} hint="1–10 scale" />
          <Stat label="Follow-ups open" value={rollup.data.followUpsOpen ?? 0} />
          <Stat
            label="Sales avg"
            value={rollup.data.byKind?.sales.average ?? '—'}
            hint={`${rollup.data.byKind?.sales.count ?? 0} responses`}
          />
          <Stat
            label="Service avg"
            value={rollup.data.byKind?.service.average ?? '—'}
            hint={`${rollup.data.byKind?.service.count ?? 0} responses`}
          />
        </div>
      )}
      {rollup.data?.note && <p className="muted small">{rollup.data.note}</p>}

      <Card title="Manager recovery queue">
        {!followUps.data?.length && !followUps.loading ? (
          <Empty>No CSI follow-ups waiting.</Empty>
        ) : (
          <ul className="list">
            {(followUps.data ?? []).map((s) => (
              <li key={s.id} className="stack">
                <span className="row between">
                  <span>
                    <Badge tone="warn">{s.followUpStatus}</Badge>{' '}
                    <Badge tone="neutral">{s.kind}</Badge>{' '}
                    {s.score != null && <Badge tone="bad">{s.score}/10</Badge>}
                  </span>
                  <span className="muted small">{s.respondedAt ? fmtDate(s.respondedAt) : ''}</span>
                </span>
                {s.comment && <span className="small">{s.comment}</span>}
                <span className="row">
                  {s.followUpStatus === 'PENDING' && (
                    <button className="btn" disabled={busy} onClick={() => void ack(s.id)}>
                      Acknowledge
                    </button>
                  )}
                  <button className="btn btn--primary" disabled={busy} onClick={() => void resolve(s.id)}>
                    Resolve
                  </button>
                  {s.conversationId && (
                    <a className="small" href={`#/inbox?conversation=${s.conversationId}`}>
                      Open inbox
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="New CSI draft">
        <div className="row">
          <label className="small">
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="SALES">SALES</option>
              <option value="SERVICE">SERVICE</option>
            </select>
          </label>
          <label className="small">
            Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="IN_PERSON">IN_PERSON</option>
              <option value="LINK">LINK</option>
              <option value="EMAIL">EMAIL</option>
              <option value="SMS">SMS (record only — no send)</option>
            </select>
          </label>
          <label className="small">
            Template
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">None</option>
              {(templates.data ?? [])
                .filter((t) => t.kind === kind)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="small">
            Lead id (optional)
            <input value={leadId} onChange={(e) => setLeadId(e.target.value)} placeholder="lead cuid" />
          </label>
          <button className="btn btn--primary" disabled={busy} onClick={() => void createDraft()}>
            Create draft
          </button>
        </div>
      </Card>

      <Card title="Staff interview templates">
        <p className="muted small">Talk tracks for phone/in-person CSI — not outbound SMS bodies.</p>
        <div className="row">
          <input
            placeholder="Template name"
            value={tplName}
            onChange={(e) => setTplName(e.target.value)}
          />
          <input
            placeholder="Script body"
            value={tplScript}
            onChange={(e) => setTplScript(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            className="btn"
            disabled={busy || tplName.trim().length < 2 || tplScript.trim().length < 10}
            onClick={() => void createTemplate()}
          >
            Save template
          </button>
        </div>
        <ul className="list">
          {(templates.data ?? []).map((t) => (
            <li key={t.id} className="stack">
              <span className="row">
                <strong>{t.name}</strong>
                <Badge tone="neutral">{t.kind}</Badge>
                <Badge tone="info">{t.defaultChannel}</Badge>
              </span>
              <span className="small muted">{t.scriptBody.slice(0, 200)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Surveys"
        actions={
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as 'ALL' | 'SALES' | 'SERVICE')}
            aria-label="Filter by kind"
          >
            <option value="ALL">All kinds</option>
            <option value="SALES">Sales</option>
            <option value="SERVICE">Service</option>
          </select>
        }
      >
        {!list.data?.length && !list.loading && <Empty>No surveys yet.</Empty>}
        <ul className="list">
          {(list.data ?? []).map((s) => (
            <li key={s.id} className="stack">
              <span className="row between">
                <span>
                  <Badge tone={statusTone(s.status)}>{s.status}</Badge>{' '}
                  <Badge tone="neutral">{s.kind ?? 'SALES'}</Badge>{' '}
                  <Badge tone="neutral">{s.channel}</Badge>
                  {s.score != null && <Badge tone="ok">{s.score}/10</Badge>}
                  {s.followUpRequired && <Badge tone="warn">follow-up</Badge>}
                </span>
                <span className="muted small">{fmtDate(s.createdAt)}</span>
              </span>
              {s.template?.name && <span className="muted small">Template: {s.template.name}</span>}
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
                    onChange={(e) => setScoreById((m) => ({ ...m, [s.id]: e.target.value }))}
                  />
                  <input
                    placeholder="Comment (optional)"
                    value={commentById[s.id] ?? ''}
                    onChange={(e) => setCommentById((m) => ({ ...m, [s.id]: e.target.value }))}
                  />
                  <button className="btn" disabled={busy} onClick={() => void record(s.id)}>
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
