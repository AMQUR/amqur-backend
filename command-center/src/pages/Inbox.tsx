import { useEffect, useState } from 'react';
import { api, session } from '../api';
import { ago, fmtDate, useAsync } from '../hooks';
import { EscalationActions, isOpenEscalation, type EscalationRow } from '../EscalationActions';
import { appointmentStatusLabel, Badge, Card, Empty, ErrorNote, statusTone } from '../ui';

function hashConversationId(): string | null {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const q = hash.indexOf('?');
  if (q < 0) return null;
  return new URLSearchParams(hash.slice(q + 1)).get('conversation');
}

type Item = {
  id: string; channel: string; handoffState: string; aiPaused: boolean; assignedUserId: string | null; language: string; lastActivityAt: string;
  department: string | null; customerName: string | null; stage: string | null; nextBestAction: string | null; selectedVin: string | null;
  appointment: { type: string; status: string; requestedDate: string | null; requestedTime: string | null } | null;
  lastMessage: { role: string; preview: string; at: string } | null; priority: { rank: number; reason: string };
};
type Detail = {
  id: string; handoffState: string; aiPaused: boolean; assignedUserId: string | null; language: string;
  summary: { text: string; stage: string | null; score: number | null; nextBestAction: string | null };
  messages: Array<{ id: string; role: string; content: string; createdAt: string; metadata: Record<string, unknown> | null }>;
  lead: { firstName: string | null; lastName: string | null; phone: string | null; email: string | null; crmSyncStatus: string; scoreReasons: Array<{ signal: string; weight: number }> | null } | null;
  appointments: Array<{ id: string; type: string; status: string; requestedDate: string | null; requestedTime: string | null; provider: string }>;
  tradeRequests: Array<{ id: string; year: number | null; make: string | null; model: string | null; mileage: number | null }>;
  financeRequests: Array<{ id: string; creditLinkState: string; downPayment: number | null; desiredPayment: number | null }>;
  partsInquiries: Array<{ id: string; suspectedPart: string | null; vin: string | null; status: string }>;
  escalations: EscalationRow[];
};

export function Inbox({ locationId }: { locationId: string }) {
  const [filter, setFilter] = useState<'all' | 'open' | 'mine'>('open');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(() => hashConversationId());
  const qs = new URLSearchParams({ ...(locationId ? { locationId } : {}), ...(filter === 'open' ? { handoff: 'open' } : {}), ...(filter === 'mine' ? { mine: 'true' } : {}), ...(q ? { q } : {}) }).toString();
  const list = useAsync(() => api<{ items: Item[] }>(`/ops/inbox?${qs}`), [qs]);
  useEffect(() => {
    const t = window.setInterval(() => void list.reload(), 15000);
    return () => window.clearInterval(t);
  }, [list]);
  const items = [...(list.data?.items ?? [])].sort((a, b) => a.priority.rank - b.priority.rank);
  return (
    <div className="page page--split">
      <aside className="inbox">
        <div className="inbox__filters" role="tablist">
          {(['open', 'mine', 'all'] as const).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={`tab${filter === f ? ' tab--on' : ''}`} onClick={() => setFilter(f)}>
              {f === 'open' ? 'Needs a person' : f === 'mine' ? 'Mine' : 'All'}
            </button>
          ))}
        </div>
        <input className="search" placeholder="Search messages" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
        <ErrorNote error={list.error} />
        {!items.length && !list.loading && <Empty>Nothing waiting. 🎉</Empty>}
        <ul className="inbox__list">
          {items.map((i) => (
            <li key={i.id}>
              <button className={`inbox__item${selected === i.id ? ' inbox__item--on' : ''}`} onClick={() => setSelected(i.id)}>
                <div className="inbox__top">
                  <strong>{i.customerName ?? 'Visitor'}</strong>
                  <span className="muted small">{ago(i.lastActivityAt)}</span>
                </div>
                <div className="small">{i.priority.reason}</div>
                <div className="muted small ellipsis">{i.lastMessage?.preview}</div>
                <div className="row">
                  {i.department && <Badge>{i.department}</Badge>}
                  {i.stage && <Badge tone={i.stage === 'HOT' ? 'bad' : 'neutral'}>{i.stage}</Badge>}
                  {i.aiPaused && <Badge tone="info">staff</Badge>}
                  {i.language !== 'en' && <Badge>{i.language}</Badge>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="convo">
        {selected ? (
          <Conversation
            id={selected}
            locationId={locationId}
            onChanged={() => void list.reload()}
          />
        ) : (
          <Empty>Select a conversation.</Empty>
        )}
      </section>
    </div>
  );
}

type Attachment = {
  id: string;
  originalName: string;
  mimeType: string;
  scannedStatus: string;
  downloadPath?: string | null;
};

function Conversation({
  id,
  locationId,
  onChanged,
}: {
  id: string;
  locationId: string;
  onChanged: () => void;
}) {
  const d = useAsync(() => api<Detail>(`/ops/conversations/${id}`), [id]);
  const attachments = useAsync(
    () =>
      api<{ attachments: Attachment[] }>(`/ops/conversations/${id}/attachments`).then(
        (r) => r.attachments ?? [],
      ),
    [id],
  );
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [fileId, setFileId] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const me = session.user?.id;
  const canTransferOverride = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(session.user?.role ?? '');
  const staff = useAsync(
    () =>
      api<Array<{ id: string; firstName: string; lastName: string; role: string }>>(
        `/ops/users${locationId ? `?locationId=${encodeURIComponent(locationId)}` : ''}`,
      ),
    [locationId],
  );
  useEffect(() => {
    const t = window.setInterval(() => void d.reload(), 8000);
    return () => window.clearInterval(t);
  }, [d]);
  const act = async (path: string, body?: unknown) => {
    setErr(null);
    try {
      await api(`/ops/conversations/${id}/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      await d.reload();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    }
  };
  const c = d.data;
  if (!c) return <ErrorNote error={d.error} />;
  const mine = c.aiPaused && c.assignedUserId === me;
  return (
    <div className="convo__wrap">
      <header className="convo__head">
        <div>
          <h2>{[c.lead?.firstName, c.lead?.lastName].filter(Boolean).join(' ') || 'Visitor'}</h2>
          <div className="muted small">{c.summary.text}</div>
        </div>
        <div className="row">
          {!c.aiPaused && (
            <button className="btn btn--primary" onClick={() => void act('takeover')}>
              Take over
            </button>
          )}
          {mine && (
            <button className="btn" onClick={() => void act('release')}>
              Return to AI
            </button>
          )}
          {c.aiPaused && !mine && <Badge tone="info">Handled by a teammate</Badge>}
          {c.aiPaused && (mine || canTransferOverride) && (
            <label className="small">
              Transfer
              <select
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
              >
                <option value="">Teammate…</option>
                {(staff.data ?? [])
                  .filter((u) => u.id !== me)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.firstName} {u.lastName} ({u.role})
                    </option>
                  ))}
              </select>
            </label>
          )}
          {c.aiPaused && (mine || canTransferOverride) && (
            <button
              className="btn"
              disabled={!transferTo}
              onClick={() => {
                if (!transferTo) return;
                void act('transfer', { toUserId: transferTo }).then(() => setTransferTo(''));
              }}
            >
              Transfer ownership
            </button>
          )}
        </div>
      </header>
      <ErrorNote error={err} />
      <div className="convo__body">
        <ol className="thread" aria-label="Messages">
          {c.messages.map((m) => {
            const meta = m.metadata ?? {};
            const kind = meta.internalNote ? 'note' : meta.author === 'staff' ? 'staff' : m.role === 'USER' ? 'user' : m.role === 'SYSTEM' ? 'system' : 'ai';
            return (
              <li key={m.id} className={`msg msg--${kind}`}>
                <div className="msg__meta">
                  {kind === 'note' ? 'Internal note' : kind === 'staff' ? String(meta.displayName ?? 'Staff') : kind === 'ai' ? 'AI concierge' : kind === 'user' ? 'Customer' : 'System'} · {fmtDate(m.createdAt)}
                </div>
                <div>{m.content}</div>
                {kind === 'ai' && (
                  <ReplyFeedback
                    conversationId={id}
                    messageId={m.id}
                    onError={(e) => setErr(e)}
                  />
                )}
              </li>
            );
          })}
        </ol>
        <aside className="facts">
          <Card title="Lead">
            {c.lead ? (
              <ul className="kv">
                <li><span>Phone</span><span>{c.lead.phone ?? '—'}</span></li>
                <li><span>Email</span><span>{c.lead.email ?? '—'}</span></li>
                <li><span>Stage</span><span>{c.summary.stage ?? '—'} ({c.summary.score ?? 0})</span></li>
                <li><span>CRM sync</span><Badge tone={statusTone(c.lead.crmSyncStatus)}>{c.lead.crmSyncStatus}</Badge></li>
              </ul>
            ) : (
              <p className="muted small">No contact captured yet.</p>
            )}
            {c.summary.nextBestAction && <p className="nba">Next: {c.summary.nextBestAction}</p>}
            {c.lead?.scoreReasons && <p className="muted small">Why: {c.lead.scoreReasons.map((r) => r.signal.replace(/_/g, ' ')).join(', ')}</p>}
          </Card>
          {c.appointments.length > 0 && (
            <Card title="Appointments">
              {c.appointments.map((a) => (
                <div key={a.id} className="row between">
                  <span>{a.type} · {a.requestedDate} {a.requestedTime}</span>
                  <Badge tone={statusTone(a.status)}>{appointmentStatusLabel(a.status)}</Badge>
                </div>
              ))}
            </Card>
          )}
          {c.tradeRequests.map((t) => (
            <Card key={t.id} title="Trade-in">
              {[t.year, t.make, t.model].filter(Boolean).join(' ')} {t.mileage ? `· ${t.mileage.toLocaleString()} mi` : ''}
            </Card>
          ))}
          {c.financeRequests.map((f) => (
            <Card key={f.id} title="Finance">
              Credit link: <Badge tone={statusTone(f.creditLinkState)}>{f.creditLinkState}</Badge> {f.downPayment ? `· $${f.downPayment.toLocaleString()} down` : ''}
            </Card>
          ))}
          {c.partsInquiries.map((p) => (
            <Card key={p.id} title="Parts">
              {p.suspectedPart ?? 'Request'} · <Badge tone={statusTone(p.status)}>{p.status}</Badge> {p.vin ? '· VIN on file' : '· needs VIN'}
            </Card>
          ))}
          {(c.escalations ?? []).filter((e) => isOpenEscalation(e.status)).map((e) => (
            <Card key={e.id} title="Open handoff">
              <p className="small">{e.reason}{e.summary ? ` — ${e.summary.slice(0, 160)}` : ''}</p>
              <span className="row">
                <Badge tone={e.urgency === 'HIGH' || e.urgency === 'CRITICAL' ? 'bad' : 'neutral'}>{e.urgency}</Badge>
                <Badge tone={e.notifiedAt ? 'ok' : 'warn'}>{e.notifiedAt ? 'CRM notified' : 'no outbound notify'}</Badge>
              </span>
              <EscalationActions escalation={e} onUpdated={() => void d.reload()} />
            </Card>
          ))}
          <Card title="Attachments">
            <p className="muted small">Only scanned-clean files can be linked. Upload via the uploads API first.</p>
            <ul className="kv">
              {(attachments.data ?? []).map((a) => (
                <li key={a.id}>
                  <span>{a.originalName}</span>
                  <span>
                    <Badge tone={a.scannedStatus === 'CLEAN' ? 'ok' : 'warn'}>{a.scannedStatus}</Badge>
                    {a.downloadPath ? (
                      <a className="small" href={a.downloadPath} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {(attachments.data ?? []).length === 0 && (
              <p className="muted small">No attachments yet.</p>
            )}
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (!fileId.trim()) return;
                setErr(null);
                void api(`/ops/conversations/${id}/attachments`, {
                  method: 'POST',
                  body: JSON.stringify({ fileId: fileId.trim() }),
                })
                  .then(() => {
                    setFileId('');
                    void attachments.reload();
                  })
                  .catch((ex) => setErr(ex instanceof Error ? ex.message : 'Attach failed'));
              }}
            >
              <input
                placeholder="File id (CLEAN)"
                value={fileId}
                onChange={(e) => setFileId(e.target.value)}
                aria-label="File id to attach"
              />
              <button className="btn" type="submit" disabled={!fileId.trim()}>
                Link file
              </button>
            </form>
          </Card>
        </aside>
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void act('reply', { text }).then(() => setText(''));
        }}
      >
        <textarea placeholder={mine ? 'Reply to the customer…' : 'Take over to reply'} disabled={!mine} value={text} onChange={(e) => setText(e.target.value)} aria-label="Reply" />
        <button className="btn btn--primary" disabled={!mine || !text.trim()}>
          Send
        </button>
      </form>
      <form
        className="composer composer--note"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim()) void act('notes', { text: note }).then(() => setNote(''));
        }}
      >
        <input placeholder="Internal note (never shown to the customer)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Internal note" />
        <button className="btn">Add note</button>
      </form>
    </div>
  );
}

const FEEDBACK: Array<{ label: string; value: string }> = [
  { label: 'Good', value: 'good_reply' },
  { label: 'Too long', value: 'too_long' },
  { label: 'Robotic', value: 'sounds_robotic' },
  { label: 'Wrong facts', value: 'wrong_facts' },
  { label: 'Wrong question', value: 'wrong_question' },
  { label: 'Needed human', value: 'needed_human' },
  { label: 'Skip weather/sports', value: 'unnecessary_weather_sports' },
];

function ReplyFeedback({
  conversationId,
  messageId,
  onError,
}: {
  conversationId: string;
  messageId: string;
  onError: (e: string) => void;
}) {
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (sent) {
    return <p className="muted small" role="status">Feedback: {sent.replace(/_/g, ' ')}</p>;
  }
  return (
    <div className="row msg__feedback" aria-label="Rate AI reply">
      {FEEDBACK.map((f) => (
        <button
          key={f.value}
          type="button"
          className="btn btn--ghost btn--tiny"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api(`/ops/conversations/${conversationId}/reply-feedback`, {
              method: 'POST',
              body: JSON.stringify({
                conversationId,
                messageId,
                label: f.value,
              }),
            })
              .then(() => setSent(f.value))
              .catch((e) => onError(e instanceof Error ? e.message : 'Feedback failed'))
              .finally(() => setBusy(false));
          }}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}
