import { useState } from 'react';
import { api, session } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, statusTone } from '../ui';

type Doc = { id: string; title: string; status: string; visibility: string; version: number; locationId: string | null; effectiveAt: string | null; expiresAt: string | null; approvedAt: string | null; lastVerifiedAt: string | null; canonicalUrl: string | null; updatedAt: string; source: { sourceType: string; authorityLevel: string } | null };
type Hit = { title: string; content: string; score: number };

const NEXT: Record<string, Array<{ to: string; label: string; manager?: boolean }>> = {
  DRAFT: [{ to: 'PENDING_REVIEW', label: 'Submit for review' }, { to: 'APPROVED', label: 'Approve', manager: true }],
  PENDING_REVIEW: [{ to: 'APPROVED', label: 'Approve', manager: true }, { to: 'REJECTED', label: 'Reject', manager: true }],
  APPROVED: [{ to: 'PUBLISHED', label: 'Publish to customers', manager: true }],
  PUBLISHED: [{ to: 'APPROVED', label: 'Unpublish', manager: true }],
  REJECTED: [{ to: 'DRAFT', label: 'Back to draft' }],
  EXPIRED: [{ to: 'DRAFT', label: 'Back to draft' }],
};

export function Knowledge({ locationId }: { locationId: string }) {
  const docs = useAsync(() => api<Doc[]>(`/knowledge/documents${locationId ? `?locationId=${locationId}` : ''}`), [locationId]);
  const [editing, setEditing] = useState<{ id?: string; title: string; content: string; visibility: string; effectiveAt: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [url, setUrl] = useState('');
  const isManager = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(session.user?.role ?? '');
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await docs.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    }
  };
  const open = async (id: string) => {
    const d = await api<Doc & { content: string }>(`/knowledge/documents/${id}`);
    setEditing({ id, title: d.title, content: d.content, visibility: d.visibility, effectiveAt: d.effectiveAt?.slice(0, 10) ?? '', expiresAt: d.expiresAt?.slice(0, 10) ?? '' });
  };
  return (
    <div className="page">
      <h1>Knowledge</h1>
      <p className="muted">Only <Badge tone="ok">PUBLISHED</Badge> + <Badge>CUSTOMER</Badge> documents inside their effective window are available to the customer assistant. Edits to published content return it to draft for review.</p>
      <ErrorNote error={docs.error ?? err} />
      <div className="row">
        <button className="btn btn--primary" onClick={() => setEditing({ title: '', content: '', visibility: 'CUSTOMER', effectiveAt: '', expiresAt: '' })}>New document</button>
        {isManager && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api('/knowledge/ingest/website', { method: 'POST', body: JSON.stringify({ url, locationId: locationId || undefined }) })).then(() => setUrl('')); }}>
            <input placeholder="https://approved-dealer-site/page" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Website page to ingest" />
            <button className="btn">Ingest approved page</button>
          </form>
        )}
      </div>
      {editing && (
        <Card title={editing.id ? 'Edit document' : 'New document'} actions={<button className="btn btn--ghost" onClick={() => setEditing(null)}>Close</button>}>
          <div className="stack">
            <label>Title<input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></label>
            <label>Content<textarea rows={10} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} /></label>
            <div className="row">
              <label>Visibility
                <select value={editing.visibility} onChange={(e) => setEditing({ ...editing, visibility: e.target.value })}>
                  <option value="CUSTOMER">Customer (AI may use)</option>
                  <option value="STAFF">Staff only</option>
                  <option value="INTERNAL">Internal</option>
                </select>
              </label>
              <label>Effective<input type="date" value={editing.effectiveAt} onChange={(e) => setEditing({ ...editing, effectiveAt: e.target.value })} /></label>
              <label>Expires<input type="date" value={editing.expiresAt} onChange={(e) => setEditing({ ...editing, expiresAt: e.target.value })} /></label>
            </div>
            <button className="btn btn--primary" onClick={() => void run(async () => {
              const body = JSON.stringify({ title: editing.title, content: editing.content, visibility: editing.visibility, effectiveAt: editing.effectiveAt ? new Date(editing.effectiveAt).toISOString() : undefined, expiresAt: editing.expiresAt ? new Date(editing.expiresAt).toISOString() : undefined, ...(editing.id ? {} : { locationId: locationId || undefined }) });
              if (editing.id) await api(`/knowledge/documents/${editing.id}`, { method: 'PATCH', body });
              else await api('/knowledge/documents', { method: 'POST', body });
              setEditing(null);
            })}>Save draft</button>
          </div>
        </Card>
      )}
      <Card title="Preview what the customer AI can retrieve">
        <form className="row" onSubmit={async (e) => { e.preventDefault(); setHits(await api<Hit[]>(`/knowledge/preview?q=${encodeURIComponent(q)}${locationId ? `&locationId=${locationId}` : ''}`)); }}>
          <input placeholder="e.g. loaner policy" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Preview query" />
          <button className="btn">Preview</button>
        </form>
        {hits && (hits.length ? <ul className="list">{hits.map((h, i) => <li key={i}><strong>{h.title}</strong><span className="muted small">{h.content.slice(0, 160)}…</span></li>)}</ul> : <Empty>Nothing customer-visible matches — the assistant would say it can’t verify this.</Empty>)}
      </Card>
      <Card>
        {!docs.data?.length ? <Empty>No documents yet.</Empty> : (
          <table className="table">
            <thead><tr><th>Title</th><th>Status</th><th>Visibility</th><th>Scope</th><th>Window</th><th>Verified</th><th>Source</th><th /></tr></thead>
            <tbody>
              {docs.data.map((d) => (
                <tr key={d.id}>
                  <td><button className="link" onClick={() => void open(d.id)}>{d.title}</button> <span className="muted small">v{d.version}</span></td>
                  <td><Badge tone={statusTone(d.status)}>{d.status}</Badge></td>
                  <td><Badge tone={d.visibility === 'CUSTOMER' ? 'info' : 'neutral'}>{d.visibility}</Badge></td>
                  <td className="small">{d.locationId ? 'Rooftop' : 'All rooftops'}</td>
                  <td className="small">{d.effectiveAt ? d.effectiveAt.slice(0, 10) : '—'} → {d.expiresAt ? d.expiresAt.slice(0, 10) : '—'}</td>
                  <td className="small">{fmtDate(d.lastVerifiedAt)}</td>
                  <td className="small">{d.source ? `${d.source.sourceType} · ${d.source.authorityLevel}` : 'Staff'}</td>
                  <td className="row">
                    {(NEXT[d.status] ?? []).filter((n) => !n.manager || isManager).map((n) => (
                      <button key={n.to} className="btn" onClick={() => void run(() => api(`/knowledge/documents/${d.id}/transition`, { method: 'POST', body: JSON.stringify({ to: n.to }) }))}>{n.label}</button>
                    ))}
                    {isManager && <button className="btn btn--ghost" onClick={() => void run(() => api(`/knowledge/documents/${d.id}/verify`, { method: 'POST' }))}>Mark verified</button>}
                    {d.status !== 'ARCHIVED' && <button className="btn btn--ghost" onClick={() => void run(() => api(`/knowledge/documents/${d.id}/transition`, { method: 'POST', body: JSON.stringify({ to: 'ARCHIVED' }) }))}>Archive</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
