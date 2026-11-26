import { useState } from 'react';
import { api, apiUpload } from '../api';
import { ago, fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, Stat } from '../ui';
import { BASE, blockText, eligibilityTone, itemLabel, itemStatusLabel, usd, type Block, type Tone } from '../crmwf/crmWorkforce';

const post = <T,>(path: string, body: object = {}) => api<T>(`${BASE}/${path}`, { method: 'POST', body: JSON.stringify(body) });
const qs = (locationId: string, extra = '') => `${extra ? `${extra}&` : ''}${locationId ? `locationId=${encodeURIComponent(locationId)}` : ''}`;
const DEPTS = ['SALES', 'SERVICE', 'PARTS'] as const;

function useAct(after: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await fn();
      if (done) setMessage(done);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/_/g, ' ') : 'Request failed');
    } finally {
      setBusy(false);
      after();
    }
  }
  return { busy, act, note: <>{message && <p role="status">{message}</p>}<ErrorNote error={error} /></> };
}

type MiningQueue = { id: string; label: string; group: string; why: string; action: string; count: number };
type MiningRow = { id: string; crmRecordId: string; firstName: string | null; lastInitial: string | null; phoneLast4: string | null; department: string; salesperson: string | null; leadSource: string | null; crmStatus: string | null; vehicleInterest: { year?: number; make?: string; model?: string } | null; ageDays: number | null; lastEngagementAt: string | null; lastEngagementBy: string | null; reason: string; recommendedAction: string; eligibility: { status: string; reason: string }; openWork: { status: string; reason: string | null } | null; dataAsOf: string; synthetic: boolean };
type WorkItem = { id: string; crmLeadId: string | null; department: string; kind: string; status: string; urgency: string; title: string; payload: Record<string, unknown>; dueAt: string | null; assigneeName: string | null; createdBy: string; createdAt: string; resolution: { crmReference?: string | null } | null };
type LeadDetail = { lead: { id: string; firstName: string | null; lastName: string | null; phoneLast4: string | null; hasPhone: boolean; hasEmail: boolean; department: string; assignedTo: string | null; leadSource: string | null; crmStatus: string | null; sourceRecordId: string; adapterKey: string; appointmentState: string; appointmentAt: string | null; agentPaused: boolean; pausedReason: string | null; asOf: string; synthetic: boolean; vehicleInterest: { year?: number; make?: string; model?: string } | null; messages: Array<{ id: string; direction: string; authorType: string; channel: string; body: string; occurredAt: string }> }; actions: Array<{ id: string; status: string; payload: { body?: string }; createdAt: string }> };
type DraftResult = { kind: 'draft' | 'handoff' | 'suppressed' | 'blocked' | 'no_draft'; actionId?: string; text?: string; channel?: string; warnings?: Block[]; blocks?: Block[]; facts?: Array<{ kind: string; text: string; asOf: string }>; recommendation?: { action: string; name: string | null; reason: string }; message?: string; reason?: string };

const who = (r: { firstName: string | null; lastInitial?: string | null }) => [r.firstName, r.lastInitial].filter(Boolean).join(' ') || 'Unnamed customer';
const car = (v: { year?: number; make?: string; model?: string } | null) => (v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : '');

/** The five things an employee works first, in order. */
const TODAY = ['unanswered_inbound', 'new_uncontacted', 'unconfirmed_appointments', 'no_followup', 'visited_unsold'];

/**
 * Daily BDC workspace. The employee stays the one who acts in the CRM: this screen prepares
 * the reply and the paperwork, and records what the employee says they did.
 */
export function WorkspaceTab({ locationId, isManager }: { locationId: string; isManager: boolean }) {
  const [queue, setQueue] = useState(TODAY[0]);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const summary = useAsync(() => api<MiningQueue[]>(`${BASE}/mining?${qs(locationId)}`), [locationId]);
  const rows = useAsync(() => api<{ rows: MiningRow[] }>(`${BASE}/mining/${queue}?${qs(locationId)}`), [queue, locationId]);
  const reload = () => {
    void summary.reload();
    void rows.reload();
  };
  const queues = (summary.data ?? []).filter((q) => TODAY.includes(q.id)).sort((a, b) => TODAY.indexOf(a.id) - TODAY.indexOf(b.id));
  return (
    <div className="page--split">
      <div className="stack" style={{ overflow: 'auto' }}>
        <ErrorNote error={summary.error ?? rows.error} />
        <div className="stack" role="group" aria-label="Today's queue">
          {queues.map((q) => (
            <button key={q.id} className={q.id === queue ? 'btn' : 'btn btn--ghost'} aria-pressed={q.id === queue} onClick={() => { setQueue(q.id); setLeadId(null); }}>
              {q.label} <Badge tone={q.count ? (q.id === 'unanswered_inbound' ? 'bad' : 'warn') : 'neutral'}>{q.count}</Badge>
            </button>
          ))}
          <button className="btn btn--ghost" onClick={() => { setEntering(true); setLeadId(null); }} disabled={!locationId}>Enter a customer from the CRM</button>
          {!locationId && <p className="muted small">Choose a rooftop to enter a customer.</p>}
        </div>
        {rows.loading && !rows.data ? <p aria-busy="true">Loading…</p> : !rows.data?.rows.length ? <Empty>Nothing in this queue.</Empty> : (
          <ul className="list" aria-label="Customers">
            {rows.data.rows.map((r) => (
              <li key={r.id}>
                <button className={r.id === leadId ? 'btn' : 'btn btn--ghost'} style={{ width: '100%', textAlign: 'left' }} onClick={() => { setLeadId(r.id); setEntering(false); }}>
                  <strong>{who(r)}</strong>{r.synthetic && <> <Badge tone="info">demo</Badge></>} <Badge tone={eligibilityTone(r.eligibility.status)}>{r.eligibility.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                  <div className="muted small">{car(r.vehicleInterest) || r.department.toLowerCase()} · {r.salesperson ?? 'unassigned'} · {r.lastEngagementAt ? `${r.lastEngagementBy} ${ago(r.lastEngagementAt)}` : 'no contact yet'}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div style={{ overflow: 'auto' }}>
        {entering && locationId ? <EnterLead locationId={locationId} onDone={(id) => { setEntering(false); setLeadId(id); reload(); }} /> : leadId ? <LeadPane key={leadId} leadId={leadId} isManager={isManager} onChange={reload} /> : <Empty>Choose a customer on the left, or enter one from the CRM.</Empty>}
      </div>
    </div>
  );
}

function EnterLead({ locationId, onDone }: { locationId: string; onDone: (id: string) => void }) {
  const [f, setF] = useState({ department: 'SALES', crmRecordId: '', firstName: '', assignedTo: '', vehicleMake: '', vehicleModel: '', customerMessage: '' });
  const a = useAct(() => undefined);
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card title="Enter a customer from the CRM">
      <p className="muted small">Only what is needed to write a reply. Do not enter a phone number, email, or anything from a credit application.</p>
      <div className="stack">
        <div className="row">
          <label className="small">Department<select value={f.department} onChange={set('department')}>{DEPTS.map((d) => <option key={d}>{d}</option>)}</select></label>
          <label className="small">CRM lead number (optional)<input maxLength={80} value={f.crmRecordId} onChange={set('crmRecordId')} /></label>
          <label className="small">First name<input maxLength={40} value={f.firstName} onChange={set('firstName')} /></label>
          <label className="small">Salesperson<input maxLength={80} value={f.assignedTo} onChange={set('assignedTo')} /></label>
        </div>
        <div className="row">
          <label className="small">Vehicle make<input maxLength={40} value={f.vehicleMake} onChange={set('vehicleMake')} /></label>
          <label className="small">Vehicle model<input maxLength={60} value={f.vehicleModel} onChange={set('vehicleModel')} /></label>
        </div>
        <label className="small">What the customer wrote<textarea rows={3} maxLength={2000} value={f.customerMessage} onChange={set('customerMessage')} /></label>
        {a.note}
        <span className="row"><button className="btn" disabled={a.busy} onClick={() => void a.act(async () => { const r = await post<{ id: string }>('assist/leads', { locationId, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')) }); onDone(r.id); }, '')}>Add customer</button></span>
      </div>
    </Card>
  );
}

function LeadPane({ leadId, isManager, onChange }: { leadId: string; isManager: boolean; onChange: () => void }) {
  const detail = useAsync(() => api<LeadDetail>(`${BASE}/leads/${leadId}`), [leadId]);
  const items = useAsync(() => api<WorkItem[]>(`${BASE}/work-items?crmLeadId=${leadId}&status=OPEN,IN_PROGRESS,STAFF_CONFIRMED`), [leadId]);
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [text, setText] = useState('');
  const [staffNote, setStaffNote] = useState('');
  const [incoming, setIncoming] = useState('');
  const [when, setWhen] = useState('');
  const [followAt, setFollowAt] = useState('');
  const [followText, setFollowText] = useState('');
  const [note, setNote] = useState('');
  const a = useAct(() => { void detail.reload(); void items.reload(); onChange(); });
  const l = detail.data?.lead;
  if (detail.loading && !l) return <p aria-busy="true">Loading…</p>;
  if (!l) return <ErrorNote error={detail.error ?? 'Not found'} />;
  return (
    <div className="stack">
      <Card title={<>{[l.firstName, l.lastName].filter(Boolean).join(' ') || 'Unnamed customer'} <span className="muted small">{car(l.vehicleInterest)}</span></>} actions={<span className="row">{l.synthetic && <Badge tone="info">demo</Badge>}{l.agentPaused ? <Badge tone="warn">with a person</Badge> : <Badge>virtual team may assist</Badge>}</span>}>
        <p className="muted small">
          CRM record {l.sourceRecordId} · {l.department.toLowerCase()} · owner {l.assignedTo ?? 'unassigned'} · {l.leadSource ?? 'source unknown'} · status {l.crmStatus ?? 'unknown'}
          {l.phoneLast4 ? ` · phone ending ${l.phoneLast4}` : ''} · appointment in CRM: {l.appointmentState.toLowerCase()}{l.appointmentAt ? ` (${fmtDate(l.appointmentAt)})` : ''} · data as of {fmtDate(l.asOf)}
        </p>
        <span className="row">
          {!l.agentPaused && <button className="btn btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`leads/${leadId}/takeover`, { reason: 'Taken over in workspace' }), 'You have this customer. The virtual team is paused on it.')}>I’ll handle this customer</button>}
          {l.agentPaused && <button className="btn btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`leads/${leadId}/resume`), 'Returned to the virtual team.')}>Return to the virtual team</button>}
          {l.agentPaused && l.pausedReason && <span className="muted small">{l.pausedReason.replace(/[_:]/g, ' ')}{isManager ? '' : ' — a manager can return it if you did not take it'}</span>}
        </span>
      </Card>
      {a.note}
      <Card title="Conversation">
        {!l.messages.length ? <Empty>No messages recorded yet.</Empty> : (
          <ul className="list" aria-label="Messages">
            {l.messages.map((m) => (
              <li key={m.id} style={{ display: 'block' }}>
                <div className="muted small">{m.authorType === 'CUSTOMER' ? 'Customer' : m.authorType === 'AGENT' ? 'Virtual team' : 'Dealership'} · {m.channel.toLowerCase()} · {fmtDate(m.occurredAt)}</div>
                <div>{m.body}</div>
              </li>
            ))}
          </ul>
        )}
        <label className="small">The customer replied (paste what they wrote)<textarea rows={2} maxLength={2000} value={incoming} onChange={(e) => setIncoming(e.target.value)} /></label>
        <span className="row"><button className="btn btn--ghost" disabled={a.busy || !incoming.trim()} onClick={() => void a.act(async () => { await post(`leads/${leadId}/messages`, { direction: 'INBOUND', text: incoming }); setIncoming(''); setDraft(null); }, 'Added to the conversation.')}>Add customer message</button></span>
      </Card>
      <Card title="Reply">
        <p className="muted small">The reply is written for you to send as yourself from the CRM. Nothing is sent from here.</p>
        <label className="small">Anything to steer it? (optional)<input maxLength={300} placeholder="e.g. offer Saturday morning" value={staffNote} onChange={(e) => setStaffNote(e.target.value)} /></label>
        <span className="row"><button className="btn" disabled={a.busy} onClick={() => void a.act(async () => { const d = await post<DraftResult>(`leads/${leadId}/draft`, staffNote ? { staffNote } : {}); setDraft(d); setText(d.text ?? ''); }, '')}>{draft?.kind === 'draft' ? 'Write a different reply' : 'Write a reply'}</button></span>
        {draft && draft.kind !== 'draft' && <p className="banner banner--warn" role="status"><strong>{draft.kind === 'handoff' ? 'This one needs a person.' : draft.kind === 'suppressed' ? 'Do not contact.' : draft.kind === 'blocked' ? 'Cannot be contacted right now.' : 'No reply written.'}</strong> {draft.message}{draft.blocks?.length ? ` ${draft.blocks.map(blockText).join('; ')}.` : ''}</p>}
        {draft?.kind === 'draft' && (
          <div className="stack">
            <label className="small">Reply ({draft.channel?.toLowerCase()})<textarea rows={3} maxLength={900} value={text} onChange={(e) => setText(e.target.value)} /></label>
            {!!draft.warnings?.length && <div className="banner banner--warn small"><strong>Check before you send:</strong><ul>{draft.warnings.map((w, i) => <li key={i}>{blockText(w)}</li>)}</ul></div>}
            <p className="muted small">{draft.facts?.length ? `Based on: ${draft.facts.map((f) => f.text).join('; ')}.` : 'No verified dealership facts were available, so the reply states none.'}{draft.recommendation ? ` Owner: ${draft.recommendation.name ?? 'none'} — ${draft.recommendation.reason}` : ''}</p>
            <span className="row">
              <button className="btn btn--ghost" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</button>
              <button className="btn" disabled={a.busy} onClick={() => void a.act(async () => { await post(`actions/${draft.actionId}/staff-confirm`, { note: text !== draft.text ? 'edited before sending' : undefined }); await post(`leads/${leadId}/messages`, { direction: 'OUTBOUND', text }); setDraft(null); }, 'Recorded: you sent it in the CRM.')}>I sent this in the CRM</button>
              <button className="btn btn--ghost" disabled={a.busy} onClick={() => void a.act(async () => { await post(`actions/${draft.actionId}/reject`, { reason: 'Not used' }); setDraft(null); }, 'Discarded. Nothing was sent.')}>Discard</button>
            </span>
          </div>
        )}
      </Card>
      <div className="grid2">
        <Card title="Appointment">
          <p className="muted small">This asks a team member to book it in the CRM. It is a request until they confirm it there.</p>
          <label className="small">Requested time<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          <span className="row">
            <button className="btn btn--ghost" disabled={a.busy || !when} onClick={() => void a.act(() => post(`leads/${leadId}/appointment`, { change: 'REQUEST', requestedAt: new Date(when).toISOString() }), 'Appointment request created.')}>Request appointment</button>
            <button className="btn btn--ghost" disabled={a.busy || !when} onClick={() => void a.act(() => post(`leads/${leadId}/appointment`, { change: 'RESCHEDULE', requestedAt: new Date(when).toISOString() }), 'Reschedule request created.')}>Request reschedule</button>
            <button className="btn btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`leads/${leadId}/appointment`, { change: 'CANCEL' }), 'Cancellation request created.')}>Request cancellation</button>
          </span>
        </Card>
        <Card title="Follow-up and notes">
          <div className="row">
            <label className="small">Follow up on<input type="datetime-local" value={followAt} onChange={(e) => setFollowAt(e.target.value)} /></label>
            <label className="small">What to do<input maxLength={500} value={followText} onChange={(e) => setFollowText(e.target.value)} /></label>
            <button className="btn btn--ghost" disabled={a.busy || !followAt || followText.trim().length < 3} onClick={() => void a.act(async () => { await post(`leads/${leadId}/follow-up`, { dueAt: new Date(followAt).toISOString(), instruction: followText }); setFollowText(''); }, 'Follow-up added.')}>Add follow-up</button>
          </div>
          <div className="row">
            <label className="small">Note for the CRM record<input maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <button className="btn btn--ghost" disabled={a.busy || note.trim().length < 3} onClick={() => void a.act(async () => { await post(`leads/${leadId}/crm-note`, { text: note }); setNote(''); }, 'Note queued for the CRM.')}>Add note</button>
          </div>
        </Card>
      </div>
      {!!items.data?.length && <Card title="Open items for this customer"><ItemList items={items.data} busy={a.busy} act={a.act} /></Card>}
    </div>
  );
}

function ItemList({ items, busy, act }: { items: WorkItem[]; busy: boolean; act: (fn: () => Promise<unknown>, done: string) => Promise<void> }) {
  const [ref, setRef] = useState<Record<string, string>>({});
  return (
    <table className="table">
      <thead><tr><th>What</th><th>For</th><th>Due</th><th>Status</th><th></th></tr></thead>
      <tbody>
        {items.map((i) => {
          const appt = i.kind.startsWith('APPOINTMENT_') && i.kind !== 'APPOINTMENT_CANCEL';
          const open = i.status === 'OPEN' || i.status === 'IN_PROGRESS';
          return (
            <tr key={i.id}>
              <td>{itemLabel(i.kind)}<div className="muted small">{i.title}{typeof i.payload.hoursCheck === 'string' ? ` · ${i.payload.hoursCheck.replace(/_/g, ' ').toLowerCase()}` : ''}{typeof i.payload.note === 'string' ? ` · ${i.payload.note}` : ''}{typeof i.payload.instruction === 'string' ? ` · ${i.payload.instruction}` : ''}</div></td>
              <td>{i.assigneeName ?? <span className="muted">unassigned</span>}<div className="muted small">{i.department.toLowerCase()} · from {i.createdBy.startsWith('agent:') ? 'virtual team' : 'staff'}</div></td>
              <td>{i.dueAt ? fmtDate(i.dueAt) : '—'}</td>
              <td><Badge tone={i.urgency === 'CRITICAL' ? 'bad' : i.status === 'STAFF_CONFIRMED' ? 'info' : i.urgency === 'HIGH' ? 'warn' : 'neutral'}>{itemStatusLabel(i.status)}</Badge>{i.resolution?.crmReference && <div className="muted small">CRM ref {i.resolution.crmReference}</div>}</td>
              <td>{open && (
                <span className="row">
                  {i.status === 'OPEN' && <button className="btn btn--tiny btn--ghost" disabled={busy} onClick={() => void act(() => post(`work-items/${i.id}/claim`), 'Yours.')}>I’ll do it</button>}
                  {appt && <input aria-label="CRM appointment reference" placeholder="CRM reference" maxLength={120} value={ref[i.id] ?? ''} onChange={(e) => setRef({ ...ref, [i.id]: e.target.value })} />}
                  <button className="btn btn--tiny" disabled={busy || (appt && !(ref[i.id] ?? '').trim())} onClick={() => void act(() => post(`work-items/${i.id}/resolve`, { outcome: 'DONE', crmReference: ref[i.id] || undefined }), 'Marked done in the CRM.')}>Done in the CRM</button>
                  <button className="btn btn--tiny btn--ghost" disabled={busy} onClick={() => void act(() => post(`work-items/${i.id}/resolve`, { outcome: 'DECLINED' }), 'Closed without action.')}>Not needed</button>
                </span>
              )}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const ITEM_FILTERS: Array<[string, string]> = [
  ['', 'Everything open'],
  ['APPOINTMENT_REQUEST,APPOINTMENT_RESCHEDULE,APPOINTMENT_CANCEL,APPOINTMENT_CONFIRM', 'Appointments'],
  ['ESCALATION', 'Customers needing a person'],
  ['QUALIFIED_BUYER', 'Ready buyers'],
  ['FOLLOW_UP', 'Follow-ups'],
  ['CRM_NOTE', 'Notes for the CRM'],
];
export function WorkItemsTab({ locationId }: { locationId: string }) {
  const [kind, setKind] = useState('');
  const [closed, setClosed] = useState(false);
  const list = useAsync(() => api<WorkItem[]>(`${BASE}/work-items?${qs(locationId, `${kind ? `kind=${kind}&` : ''}status=${closed ? 'STAFF_CONFIRMED,DECLINED,CANCELLED' : 'OPEN,IN_PROGRESS'}`)}`), [kind, closed, locationId]);
  const a = useAct(() => void list.reload());
  return (
    <div className="stack">
      <div className="row" role="group" aria-label="Filter work items">
        {ITEM_FILTERS.map(([id, label]) => <button key={id} className={id === kind ? 'btn' : 'btn btn--ghost'} aria-pressed={id === kind} onClick={() => setKind(id)}>{label}</button>)}
        <label className="small"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Show closed</label>
      </div>
      <p className="muted small">These are requests for a team member to act in the CRM. “Done in the CRM” records the employee’s statement; an appointment needs the CRM’s own reference.</p>
      <ErrorNote error={list.error} />
      {a.note}
      {list.loading && !list.data ? <p aria-busy="true">Loading…</p> : !list.data?.length ? <Empty>Nothing here.</Empty> : <ItemList items={list.data} busy={a.busy} act={a.act} />}
    </div>
  );
}

export function MiningTab({ locationId }: { locationId: string }) {
  const [queue, setQueue] = useState('no_followup');
  const summary = useAsync(() => api<MiningQueue[]>(`${BASE}/mining?${qs(locationId)}`), [locationId]);
  const rows = useAsync(() => api<{ rows: MiningRow[]; queue: MiningQueue }>(`${BASE}/mining/${queue}?${qs(locationId)}`), [queue, locationId]);
  const groups = ['Now', 'Follow-up', 'Recovery', 'Departments'];
  return (
    <div className="stack">
      <ErrorNote error={summary.error ?? rows.error} />
      {groups.map((g) => (
        <div key={g} className="row" role="group" aria-label={g}>
          <span className="muted small" style={{ minWidth: 90 }}>{g}</span>
          {(summary.data ?? []).filter((q) => q.group === g).map((q) => <button key={q.id} className={q.id === queue ? 'btn btn--tiny' : 'btn btn--tiny btn--ghost'} aria-pressed={q.id === queue} onClick={() => setQueue(q.id)}>{q.label} · {q.count}</button>)}
        </div>
      ))}
      {rows.data && <p className="muted small">{rows.data.queue.why} Being in a queue is not permission to contact: each row shows whether anything on record forbids it.</p>}
      {rows.loading && !rows.data ? <p aria-busy="true">Loading…</p> : !rows.data?.rows.length ? <Empty>No leads in this queue.</Empty> : (
        <table className="table">
          <thead><tr><th>Customer</th><th>Interest</th><th>Salesperson</th><th>Last engagement</th><th>Can we contact?</th><th>Recommended</th></tr></thead>
          <tbody>
            {rows.data.rows.map((r) => (
              <tr key={r.id}>
                <td>{who(r)}{r.synthetic && <> <Badge tone="info">demo</Badge></>}<div className="muted small">CRM {r.crmRecordId}{r.ageDays !== null ? ` · ${r.ageDays} days old` : ''}{r.crmStatus ? ` · ${r.crmStatus}` : ''}</div></td>
                <td>{car(r.vehicleInterest) || '—'}<div className="muted small">{r.department.toLowerCase()}{r.leadSource ? ` · ${r.leadSource}` : ''}</div></td>
                <td>{r.salesperson ?? <span className="muted">unassigned</span>}</td>
                <td>{r.lastEngagementAt ? <>{ago(r.lastEngagementAt)}<div className="muted small">by {r.lastEngagementBy}</div></> : <span className="muted">none recorded</span>}</td>
                <td><Badge tone={eligibilityTone(r.eligibility.status)}>{r.eligibility.status.replace(/_/g, ' ').toLowerCase()}</Badge><div className="muted small">{r.eligibility.reason}</div></td>
                <td>{r.recommendedAction}{r.openWork && <div className="muted small">in progress: {r.openWork.status.replace(/_/g, ' ').toLowerCase()}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

type Batch = { id: string; status: string; fileName: string | null; exportedAt: string; synthetic: boolean; mapping: Record<string, string>; counts: Record<string, number> & { committed?: Record<string, number>; rollback?: Record<string, number> }; validation: { rejectedRows: Array<{ row: number; reason: string }>; ignoredColumns: string[]; unmappedFields: string[]; warnings: string[] }; createdAt: string };
type Preview = { batch: Batch; headers: string[]; fields: Record<string, string>; sample: Array<Record<string, string | boolean | null>> };

export function ImportsTab({ locationId, connected }: { locationId: string; connected: boolean }) {
  const list = useAsync(() => api<Batch[]>(`${BASE}/imports?${qs(locationId)}`), [locationId]);
  const [file, setFile] = useState<File | null>(null);
  const [exportedAt, setExportedAt] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const a = useAct(() => void list.reload());
  const form = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    if (file) fd.append('file', file);
    fd.append('locationId', locationId);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fd;
  };
  const run = (m: Record<string, string>) => a.act(async () => {
    const p = await apiUpload<Preview>(`${BASE}/imports/preview`, form({ exportedAt: new Date(exportedAt).toISOString(), ...(Object.keys(m).length ? { mapping: JSON.stringify(m) } : {}) }));
    setPreview(p);
    setMapping(p.batch.mapping);
  }, '');
  if (!locationId) return <Empty>Choose a rooftop to import a CRM export.</Empty>;
  return (
    <div className="stack">
      <Card title="Import a CRM export">
        {!connected && <p className="banner banner--warn small">The CRM export connection is not switched on for this rooftop. An administrator records the import authorisation under CRM connections.</p>}
        <p className="small">Export leads from the CRM as CSV and upload the file. You will see what it would change before anything is saved, and an import can be undone. Files with Social Security, licence, date-of-birth, credit, income or bank columns are refused. Real customer files are accepted only once this rooftop is authorised for them.</p>
        <div className="row">
          <label className="small">Export file<input type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setMapping({}); }} /></label>
          <label className="small">When was it exported?<input type="datetime-local" value={exportedAt} onChange={(e) => setExportedAt(e.target.value)} /></label>
          <button className="btn" disabled={a.busy || !file || !exportedAt || !connected} onClick={() => void run({})}>Preview</button>
        </div>
        {a.note}
        {preview && (
          <div className="stack">
            <div className="stats">
              <Stat label="Rows in file" value={preview.batch.counts.rows} />
              <Stat label="New leads" value={preview.batch.counts.created} />
              <Stat label="Changed" value={preview.batch.counts.updated} />
              <Stat label="Unchanged" value={preview.batch.counts.unchanged} />
              <Stat label="Same contact as another lead" value={preview.batch.counts.duplicates} />
              <Stat label="Opted out / do not contact" value={preview.batch.counts.suppressed} />
              <Stat label="Rejected rows" value={preview.batch.counts.rejected} />
            </div>
            <p><Badge tone={preview.batch.synthetic ? 'info' : 'warn'}>{preview.batch.synthetic ? 'TEST FILE — reserved test contacts only' : 'REAL CUSTOMER DATA'}</Badge></p>
            {!!preview.batch.validation.warnings.length && <div className="banner banner--warn small"><ul>{preview.batch.validation.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
            <details open>
              <summary className="small">Column mapping ({Object.keys(mapping).length} of {Object.keys(preview.fields).length} fields)</summary>
              <table className="table">
                <thead><tr><th>Field</th><th>Column in your file</th></tr></thead>
                <tbody>{Object.entries(preview.fields).map(([field, label]) => (
                  <tr key={field}><td>{label}</td><td><select aria-label={label} value={mapping[field] ?? ''} onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}><option value="">— not in file —</option>{preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}</select></td></tr>
                ))}</tbody>
              </table>
              <span className="row"><button className="btn btn--ghost" disabled={a.busy} onClick={() => void run(Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)))}>Preview again with this mapping</button></span>
            </details>
            {!!preview.batch.validation.rejectedRows.length && <details><summary className="small">Rejected rows ({preview.batch.validation.rejectedRows.length})</summary><ul className="small">{preview.batch.validation.rejectedRows.slice(0, 50).map((r, i) => <li key={i}>Row {r.row}: {r.reason.replace(/_/g, ' ')}</li>)}</ul></details>}
            {!!preview.sample.length && <details><summary className="small">First rows as they will be read</summary><table className="table"><thead><tr>{Object.keys(preview.sample[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead><tbody>{preview.sample.map((r, i) => <tr key={i}>{Object.values(r).map((v, j) => <td key={j}>{v === null ? '—' : String(v)}</td>)}</tr>)}</tbody></table></details>}
            <span className="row"><button className="btn" disabled={a.busy} onClick={() => void a.act(async () => { await apiUpload(`${BASE}/imports/${preview.batch.id}/commit`, form()); setPreview(null); setFile(null); }, 'Imported.')}>Import these leads</button><button className="btn btn--ghost" onClick={() => setPreview(null)}>Cancel</button></span>
          </div>
        )}
      </Card>
      <Card title="Import history">
        <ErrorNote error={list.error} />
        {!list.data?.length ? <Empty>No imports yet.</Empty> : (
          <table className="table">
            <thead><tr><th>File</th><th>Exported</th><th>Result</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.data.map((b, idx) => {
              const c = b.counts.committed ?? b.counts;
              const newest = list.data!.findIndex((x) => x.status === 'COMMITTED') === idx;
              return (
                <tr key={b.id}>
                  <td>{b.fileName ?? 'export'}{b.synthetic && <> <Badge tone="info">test file</Badge></>}<div className="muted small">uploaded {ago(b.createdAt)}</div></td>
                  <td>{fmtDate(b.exportedAt)}</td>
                  <td className="small">{c.created} new · {c.updated} changed · {c.unchanged} unchanged · {c.duplicates} duplicate{b.counts.rollback ? ` · undone: ${b.counts.rollback.removed} removed, ${b.counts.rollback.restored} restored, ${b.counts.rollback.keptBecauseContacted} kept (already contacted)` : ''}</td>
                  <td><Badge tone={b.status === 'COMMITTED' ? 'ok' : b.status === 'ROLLED_BACK' ? 'neutral' : 'warn'}>{b.status === 'COMMITTED' ? 'imported' : b.status === 'ROLLED_BACK' ? 'undone' : 'previewed only'}</Badge></td>
                  <td>{b.status === 'COMMITTED' && newest && <button className="btn btn--tiny btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`imports/${b.id}/rollback`, { locationId, reason: 'Undone from Command Center' }), 'Import undone.')}>Undo this import</button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

type RosterRow = { key: string; name: string; scope: string; responsibility: string; runsOn: string; limits: string; mode: string; state: string; authorization: string; connection: string; workload: number; awaitingApproval: number; lastSuccessfulAt: string | null; recentErrors: number };
export function RosterCard({ locationId }: { locationId: string }) {
  const r = useAsync(() => api<RosterRow[]>(`${BASE}/roster?${qs(locationId)}`), [locationId]);
  const tone = (s: string): Tone => (s === 'RUNNING' ? 'ok' : s === 'STOPPED' || s === 'NO WORKER' ? 'bad' : 'neutral');
  return (
    <Card title="Workforce roster">
      <p className="muted small">Eighteen responsibilities in one system. Most are rules and queries; only those marked “writes messages” use the AI model, and only when a message is needed. Workload and last activity are recorded work — a role with none shows none.</p>
      <ErrorNote error={r.error} />
      {!r.data ? <p aria-busy="true">Loading…</p> : (
        <table className="table">
          <thead><tr><th>Role</th><th>State</th><th>Permission</th><th>Workload</th><th>Awaiting approval</th><th>Last successful</th><th>Errors (24h)</th></tr></thead>
          <tbody>{r.data.map((x) => (
            <tr key={x.key}>
              <td><strong>{x.name}</strong> <Badge tone={x.runsOn === 'model' ? 'info' : 'neutral'}>{x.runsOn === 'model' ? 'writes messages' : 'rules'}</Badge><div className="muted small">{x.responsibility}</div><div className="muted small">Never: {x.limits}</div></td>
              <td><Badge tone={tone(x.state)}>{x.state.toLowerCase()}</Badge><div className="muted small">{x.scope === 'GROUP' ? 'group' : 'this rooftop'} · {x.mode.replace(/_/g, ' ').toLowerCase()}</div></td>
              <td className="small">{x.authorization}<div className="muted small">{x.connection}</div></td>
              <td>{x.workload}</td>
              <td>{x.awaitingApproval}</td>
              <td>{x.lastSuccessfulAt ? ago(x.lastSuccessfulAt) : <span className="muted">none recorded</span>}</td>
              <td>{x.recentErrors ? <Badge tone="bad">{x.recentErrors}</Badge> : 0}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

type Finding = { severity: string; area: string; finding: string; count: number; recommendation: string };
export function DirectorCard({ locationId }: { locationId: string }) {
  const f = useAsync(() => api<Finding[]>(`${BASE}/director?${qs(locationId)}`), [locationId]);
  return (
    <Card title="Needs attention">
      <ErrorNote error={f.error} />
      {!f.data ? <p aria-busy="true">Loading…</p> : !f.data.length ? <Empty>Nothing needs attention right now.</Empty> : (
        <table className="table">
          <thead><tr><th></th><th>What</th><th>How many</th><th>What to do</th></tr></thead>
          <tbody>{f.data.map((x, i) => <tr key={i}><td><Badge tone={x.severity === 'CRITICAL' ? 'bad' : x.severity === 'HIGH' ? 'warn' : 'neutral'}>{x.severity.toLowerCase()}</Badge></td><td>{x.finding}<div className="muted small">{x.area}</div></td><td>{x.count}</td><td>{x.recommendation}</td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}

type Report = { kind: string; generatedAt: string; periodHours: number; note: string; customers: Record<string, number>; openWorkByPriority: Array<{ priority: number; count: number }>; staffWorkItems: Array<{ kind: string; status: string; count: number }>; messages: Record<string, number>; outcomes: Array<{ kind: string; basis: string; fromCrm: boolean; count: number }>; compliance: { optOutsRecorded: number }; cost: { modelCalls: number; modelCostMicroUsd: number }; needsAttention: Finding[] };
const REPORTS: Array<[string, string]> = [['morning', 'Morning'], ['midday', 'Midday'], ['end_of_day', 'End of day'], ['weekly', 'Weekly']];
const LABEL: Record<string, string> = { repliesReceived: 'Customer replies', newLeads: 'New leads', waitingOnReply: 'Waiting on a reply now', appointmentsNext24h: 'Appointments in next 24h (CRM)', draftsWaiting: 'Drafts waiting', sentConfirmedInCrm: 'Sent, confirmed in CRM', sentByEmployees: 'Sent by employees', unknownResult: 'Unknown result', blocked: 'Blocked by policy' };
export function ReportsCard({ locationId }: { locationId: string }) {
  const [kind, setKind] = useState('morning');
  const r = useAsync(() => api<Report>(`${BASE}/reports/${kind}?${qs(locationId)}`), [kind, locationId]);
  return (
    <Card title="Management report" actions={<span className="row">{REPORTS.map(([id, label]) => <button key={id} className={id === kind ? 'btn btn--tiny' : 'btn btn--tiny btn--ghost'} aria-pressed={id === kind} onClick={() => setKind(id)}>{label}</button>)}</span>}>
      <ErrorNote error={r.error} />
      {!r.data ? <p aria-busy="true">Loading…</p> : (
        <div className="stack">
          <p className="muted small">Last {r.data.periodHours} hours, generated {fmtDate(r.data.generatedAt)}. {r.data.note} Reports are produced on request; scheduled delivery is not set up.</p>
          <div className="stats">
            {Object.entries({ ...r.data.customers, ...r.data.messages }).map(([k, v]) => <Stat key={k} label={LABEL[k] ?? k} value={v} />)}
            <Stat label="Opt-outs recorded" value={r.data.compliance.optOutsRecorded} />
            <Stat label="Model cost" value={usd(r.data.cost.modelCostMicroUsd)} hint={`${r.data.cost.modelCalls} calls`} />
          </div>
          {!r.data.outcomes.length ? <p className="muted small">No outcomes recorded in this period.</p> : <ul className="kv">{r.data.outcomes.map((o, i) => <li key={i}><span>{o.kind === 'DEAL_CREATED' ? 'Deal record created (not a verified sale)' : o.kind.replace(/_/g, ' ').toLowerCase()} · {o.basis.toLowerCase()} · {o.fromCrm ? 'from CRM' : 'staff-stated or demo'}</span><span>{o.count}</span></li>)}</ul>}
          {!!r.data.staffWorkItems.length && <ul className="kv">{r.data.staffWorkItems.map((w, i) => <li key={i}><span>{itemLabel(w.kind)} · {itemStatusLabel(w.status)}</span><span>{w.count}</span></li>)}</ul>}
        </div>
      )}
    </Card>
  );
}

export function PrivacyCard() {
  const ret = useAsync(() => api<{ retentionDays: number; legalHold: boolean; recordsPastRetention: number; vaultReady: boolean }>(`${BASE}/privacy/retention`), []);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const a = useAct(() => void ret.reload());
  const body = () => ({ ...(phone ? { phone } : {}), ...(email ? { email } : {}), reason });
  const ready = (phone || email) && reason.trim().length >= 3;
  return (
    <Card title="Customer data">
      <ErrorNote error={ret.error} />
      {ret.data && (
        <ul className="kv">
          <li><span>Contact details and messages encrypted at rest</span><span><Badge tone={ret.data.vaultReady ? 'ok' : 'bad'}>{ret.data.vaultReady ? 'yes' : 'key missing — nothing can be stored'}</Badge></span></li>
          <li><span>Kept for</span><span>{ret.data.retentionDays} days after last activity{ret.data.legalHold ? ' (legal hold: nothing is deleted)' : ''}</span></li>
          <li><span>Records past that period, removed at the next daily purge</span><span>{ret.data.recordsPastRetention}</span></li>
        </ul>
      )}
      <p className="small">Customer request: export or erase what the workforce holds about one person. Erasing keeps their opt-out in force. This does not change the CRM.</p>
      <div className="row">
        <label className="small">Phone<input maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        <label className="small">or email<input maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="small">Reason<input maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      </div>
      <span className="row">
        <button className="btn btn--ghost" disabled={a.busy || !ready} onClick={() => void a.act(async () => {
          const r = await post<{ records: unknown[] }>('privacy/export', body());
          const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = 'customer-data-export.json';
          link.click();
          URL.revokeObjectURL(url);
          setResult(`${r.records.length} record(s) exported.`);
        }, '')}>Export</button>
        <button className="btn btn--danger" disabled={a.busy || !ready} onClick={() => { if (window.confirm('Erase this customer from the workforce? This cannot be undone. Their opt-out stays in force.')) void a.act(async () => { const r = await post<{ leads: number; messages: number; suppressionsKept: number }>('privacy/erase', body()); setResult(`Erased ${r.leads} record(s) and ${r.messages} message(s). ${r.suppressionsKept} opt-out(s) kept.`); setPhone(''); setEmail(''); }, ''); }}>Erase</button>
      </span>
      {a.note}
      {result && <p role="status">{result}</p>}
    </Card>
  );
}
