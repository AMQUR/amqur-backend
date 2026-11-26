import { useState } from 'react';
import { api, session } from '../api';
import { ago, fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote } from '../ui';
import { BASE, type Tone } from '../crmwf/crmWorkforce';

const post = <T,>(path: string, body: object = {}) => api<T>(`${BASE}/${path}`, { method: 'POST', body: JSON.stringify(body) });
const loc = (l: string) => `locationId=${encodeURIComponent(l)}`;

type HealthItem = { item: string; department: string | null; status: string; source: string | null; verifiedAt: string | null; detail: string; fixAt: string };
type Entry = { id: string; kind: string; department: string | null; title: string; body: string; data: Record<string, string> | null; source: string; status: string; state: string; verifiedAt: string; expiresAt: string | null; proposedById: string | null; reviewNote: string | null };
type Feed = { feedSourceKey: string; name: string; state: string; lastSuccessAt: string | null; vehiclesAvailable: number; missingDependency: string[] };
type Car = { vin: string; stock: string | null; year: number; make: string; model: string; trim: string | null; color: string | null; condition: string | null; status: string; freshnessState: string; lastSeenAt: string | null; price: number | null };

export const healthTone = (s: string): Tone => (s === 'OK' ? 'ok' : s === 'PENDING' ? 'info' : s === 'MISSING' || s === 'BLOCKED' ? 'warn' : 'bad');
const KINDS: Array<{ id: string; label: string; person?: boolean }> = [
  { id: 'ESCALATION_CONTACT', label: 'Escalation contact', person: true },
  { id: 'DEPARTMENT_MANAGER', label: 'Department manager', person: true },
  { id: 'STAFF_MEMBER', label: 'Staff member', person: true },
  { id: 'POLICY', label: 'Customer policy' },
  { id: 'AGENT_INSTRUCTION', label: 'Store guidance for agents' },
];

function useAct(after: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await fn();
      setMsg(done);
    } catch (e) {
      setErr(e instanceof Error ? e.message.replace(/_/g, ' ') : 'Request failed');
    } finally {
      setBusy(false);
      after();
    }
  }
  return { busy, act, note: <>{msg && <p role="status">{msg}</p>}<ErrorNote error={err} /></> };
}

/**
 * Store knowledge used by both the website Concierge and CRM Workforce: what is on file, where
 * it comes from, and what is missing. Hours are edited in Rooftop settings and offers in
 * Spotlights; everything else is proposed and approved here.
 */
export function KnowledgeTab({ locationId, isManager, isAdmin }: { locationId: string; isManager: boolean; isAdmin: boolean }) {
  const health = useAsync(() => (locationId ? api<{ store: string; items: HealthItem[] }>(`${BASE}/knowledge/health?${loc(locationId)}`) : Promise.resolve(null)), [locationId]);
  const entries = useAsync(() => (locationId ? api<Entry[]>(`${BASE}/knowledge/entries?${loc(locationId)}`) : Promise.resolve([])), [locationId]);
  const reload = () => {
    void health.reload();
    void entries.reload();
  };
  const a = useAct(reload);
  const me = session.user?.id;
  if (!locationId) return <Card title="Store knowledge"><Empty>Choose a rooftop at the top left.</Empty></Card>;
  const items = health.data?.items ?? [];
  const gaps = items.filter((i) => i.status !== 'OK');
  return (
    <>
      <Card title={`Store knowledge — ${health.data?.store ?? ''}`}>
        <p className="muted small">The website Concierge and CRM Workforce read the same facts. Agents use only approved, current facts; anything missing below is something they will not state. {gaps.length ? `${gaps.length} item(s) need attention.` : 'Nothing needs attention.'}</p>
        <ErrorNote error={health.error} />
        {!health.data ? <p aria-busy="true">Loading…</p> : (
          <table className="table">
            <thead><tr><th>Item</th><th>Status</th><th>Detail</th><th>Source · verified</th><th>Fix in</th></tr></thead>
            <tbody>{[...gaps, ...items.filter((i) => i.status === 'OK')].map((i, n) => (
              <tr key={n}>
                <td>{i.item}{i.department && <div className="muted small">{i.department.toLowerCase()}</div>}</td>
                <td><Badge tone={healthTone(i.status)}>{i.status.toLowerCase()}</Badge></td>
                <td className="small">{i.detail}</td>
                <td className="small muted">{i.source ?? '—'}{i.verifiedAt ? ` · ${String(i.verifiedAt).slice(0, 10)}` : ''}</td>
                <td className="small">{i.fixAt === 'Rooftop settings → Hours' || i.fixAt.startsWith('Rooftop settings') ? <a href="#/settings">{i.fixAt}</a> : i.fixAt === 'Spotlights' || i.fixAt.startsWith('Spotlights') ? <a href="#/spotlights">{i.fixAt}</a> : i.fixAt}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {a.note}
      {isManager && <ProposeForm locationId={locationId} act={a.act} busy={a.busy} />}
      <Card title="Entries" actions={isAdmin ? <button className="btn btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`knowledge/apply-escalation-recipients?${loc(locationId)}`), 'Approved escalation e-mails now receive Concierge escalations for this store.')}>Apply escalation contacts to Concierge</button> : undefined}>
        <ErrorNote error={entries.error} />
        {!entries.data?.length ? <Empty>No staff, managers, escalation contacts, policies or guidance on file yet.</Empty> : (
          <table className="table">
            <thead><tr><th>Entry</th><th>State</th><th>Source</th><th>Review</th>{isManager && <th />}</tr></thead>
            <tbody>{entries.data.map((e) => (
              <tr key={e.id}>
                <td><strong>{e.title}</strong> <span className="muted small">{KINDS.find((k) => k.id === e.kind)?.label}{e.department ? ` · ${e.department.toLowerCase()}` : ''}</span><div className="small">{e.data?.name ? `${e.data.name}${e.data.role ? `, ${e.data.role}` : ''}${e.data.email ? ` · ${e.data.email}` : ''}${e.data.phone ? ` · ${e.data.phone}` : ''}` : e.body}</div></td>
                <td><Badge tone={e.state === 'ACTIVE' ? 'ok' : e.status === 'PROPOSED' ? 'info' : e.status === 'REJECTED' ? 'neutral' : 'bad'}>{e.status === 'APPROVED' ? e.state.toLowerCase() : e.status.toLowerCase()}</Badge>{e.expiresAt && <div className="muted small">ends {fmtDate(e.expiresAt)}</div>}</td>
                <td className="small muted">{e.source}<div>verified {ago(e.verifiedAt)}</div></td>
                <td className="small">{e.reviewNote ?? ''}</td>
                {isManager && (
                  <td className="row">
                    {e.status === 'PROPOSED' && (e.proposedById !== me || isAdmin) && <>
                      <button className="btn" disabled={a.busy} onClick={() => void a.act(() => post(`knowledge/entries/${e.id}/review`, { approve: true }), 'Approved.')}>Approve</button>
                      <button className="btn btn--ghost" disabled={a.busy} onClick={() => { const note = window.prompt('Why is this rejected?') ?? ''; void a.act(() => post(`knowledge/entries/${e.id}/review`, { approve: false, note }), 'Rejected.'); }}>Reject</button>
                    </>}
                    {e.status === 'PROPOSED' && e.proposedById === me && !isAdmin && <span className="muted small">another manager approves</span>}
                    {e.status === 'APPROVED' && <button className="btn btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`knowledge/entries/${e.id}/reverify`), 'Marked as still correct.')}>Still correct</button>}
                    {e.status === 'APPROVED' && <button className="btn btn--ghost" disabled={a.busy} onClick={() => { if (window.confirm('Retire this entry? Agents stop using it at once.')) void a.act(() => post(`knowledge/entries/${e.id}/retire`), 'Retired.'); }}>Retire</button>}
                  </td>
                )}
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <InventoryCard locationId={locationId} />
      <InventoryChangesCard locationId={locationId} />
    </>
  );
}

function ProposeForm({ locationId, act, busy }: { locationId: string; act: (fn: () => Promise<unknown>, done: string) => Promise<void>; busy: boolean }) {
  const blank = { kind: 'ESCALATION_CONTACT', department: '', title: '', body: '', name: '', role: '', email: '', phone: '', source: '', expiresAt: '' };
  const [f, setF] = useState(blank);
  const person = KINDS.find((k) => k.id === f.kind)?.person;
  return (
    <Card title="Add knowledge">
      <p className="muted small">Every entry needs its source (who or what confirmed it). It is used only after a second manager or an administrator approves it, and it stops being used when it expires or is not re-confirmed within 90 days. Store guidance can shape tone and focus but can never override the compliance rules or the verified-facts rule.</p>
      <form className="row wrap" onSubmit={(e) => {
        e.preventDefault();
        const data = person ? { name: f.name, role: f.role || undefined, email: f.email || undefined, phone: f.phone || undefined } : undefined;
        void act(async () => {
          await post('knowledge/entries', { locationId, kind: f.kind, department: f.department || undefined, title: f.title || f.name, body: f.body || f.title || f.name, data, source: f.source, expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : undefined });
          setF(blank);
        }, 'Proposed. It is used once approved.');
      }}>
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Kind">{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
        <select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} aria-label="Department"><option value="">Whole store</option><option value="SALES">Sales</option><option value="SERVICE">Service</option><option value="PARTS">Parts</option></select>
        {person ? <>
          <input required placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Name" />
          <input placeholder="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} aria-label="Role" />
          <input type="email" placeholder="Work e-mail" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-label="Work e-mail" />
          <input placeholder="Work phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} aria-label="Work phone" />
          <input placeholder="What they handle" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} aria-label="What they handle" />
        </> : <>
          <input required placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="Title" />
          <textarea required placeholder={f.kind === 'AGENT_INSTRUCTION' ? 'Guidance (max 600 characters)' : 'Policy text'} maxLength={f.kind === 'AGENT_INSTRUCTION' ? 600 : 4000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} aria-label="Text" style={{ minWidth: 320 }} />
        </>}
        <input required minLength={3} placeholder="Source (e.g. GM, 25 Nov)" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} aria-label="Source" />
        <label className="small">Ends <input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} aria-label="Ends" /></label>
        <button className="btn btn--primary" disabled={busy}>Propose</button>
      </form>
    </Card>
  );
}

function InventoryCard({ locationId }: { locationId: string }) {
  const feeds = useAsync(() => api<{ feeds: Feed[]; syncEnabled: boolean; sftpEnabled: boolean; sftpCredentials: boolean; pricesPublished: boolean }>(`${BASE}/inventory/feeds?${loc(locationId)}`), [locationId]);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ by: string; results: Car[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Inventory">
      <ErrorNote error={feeds.error ?? err} />
      {feeds.data && (
        <table className="table">
          <thead><tr><th>Feed</th><th>State</th><th>Vehicles</th><th>Last success</th><th>Missing</th></tr></thead>
          <tbody>{feeds.data.feeds.map((f) => (
            <tr key={f.feedSourceKey}><td>{f.name}</td><td><Badge tone={f.state === 'ARRIVING' ? 'ok' : f.state === 'STALE' ? 'warn' : 'bad'}>{f.state.replace('_', ' ').toLowerCase()}</Badge></td><td>{f.vehiclesAvailable}</td><td>{f.lastSuccessAt ? ago(f.lastSuccessAt) : 'never'}</td><td className="small">{f.missingDependency.join('; ') || '—'}</td></tr>
          ))}</tbody>
        </table>
      )}
      {feeds.data && !feeds.data.pricesPublished && <p className="muted small">Prices from the feed are not published (AMQUR_VAUTO_PUBLISH_PRICES is off), so agents never quote a price.</p>}
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          setRes(await api(`${BASE}/inventory/lookup?q=${encodeURIComponent(q)}&${loc(locationId)}`));
        } catch (x) {
          setErr(x instanceof Error ? x.message.replace(/_/g, ' ') : 'Lookup failed');
        }
      }}>
        <input placeholder="VIN, stock number, or make and model" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Inventory search" style={{ minWidth: 280 }} />
        <button className="btn" disabled={q.trim().length < 2}>Look up</button>
      </form>
      {res && (!res.results.length ? <Empty>No vehicle at this store matches. That does not prove the store has none: check the feed state above.</Empty> : (
        <table className="table">
          <thead><tr><th>Vehicle</th><th>Stock / VIN</th><th>Status</th><th>Feed freshness</th></tr></thead>
          <tbody>{res.results.map((c) => (
            <tr key={c.vin}><td>{c.year} {c.make} {c.model} {c.trim ?? ''}<div className="muted small">{[c.condition, c.color].filter(Boolean).join(' · ')}</div></td><td className="small">{c.stock ?? '—'}<div className="muted">{c.vin}</div></td><td><Badge tone={c.status === 'AVAILABLE' ? 'ok' : 'warn'}>{c.status.toLowerCase().replace('_', ' ')}</Badge></td><td className="small">{c.freshnessState.toLowerCase()} · {c.lastSeenAt ? ago(c.lastSeenAt) : 'never seen'}</td></tr>
          ))}</tbody>
        </table>
      ))}
    </Card>
  );
}

type Change = { vin: string; stock: string | null; year: number; make: string; model: string; trim: string | null; status: string };
/** Recent inventory movement: added, missing from the feed, removed; and VINs another store also lists. */
function InventoryChangesCard({ locationId }: { locationId: string }) {
  const c = useAsync(() => api<{ added: Change[]; missing: Change[]; removed: Change[]; duplicateVinsElsewhere: Array<{ vin: string; alsoListedBy: string }> }>(`${BASE}/inventory/changes?hours=24&${loc(locationId)}`), [locationId]);
  const d = c.data;
  const row = (v: Change) => <li key={v.vin} className="small">{v.year} {v.make} {v.model} {v.trim ?? ''} · stock {v.stock ?? '—'} · {v.status.toLowerCase().replace('_', ' ')}</li>;
  return (
    <Card title="Inventory changes (24 h)">
      <ErrorNote error={c.error} />
      {d && (!d.added.length && !d.missing.length && !d.removed.length && !d.duplicateVinsElsewhere.length ? <Empty>No inventory changes recorded in the last 24 hours.</Empty> : (
        <div className="grid2">
          <div><strong>Added ({d.added.length})</strong><ul>{d.added.slice(0, 20).map(row)}</ul></div>
          <div><strong>Missing from the feed ({d.missing.length})</strong><ul>{d.missing.slice(0, 20).map(row)}</ul><p className="muted small">Missing is not sold: no sale is recorded without the vendor’s evidence.</p></div>
          <div><strong>Removed ({d.removed.length})</strong><ul>{d.removed.slice(0, 20).map(row)}</ul></div>
          {!!d.duplicateVinsElsewhere.length && <div><Badge tone="warn">same VIN at another store</Badge><ul>{d.duplicateVinsElsewhere.map((x) => <li key={x.vin + x.alsoListedBy} className="small">{x.vin} — also listed by {x.alsoListedBy}</li>)}</ul></div>}
        </div>
      ))}
    </Card>
  );
}
