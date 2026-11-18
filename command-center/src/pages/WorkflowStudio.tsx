import { useEffect, useMemo, useState } from 'react';
import { api, session } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, statusTone } from '../ui';
import {
  diffGraphs,
  layout,
  newNode,
  NODE_LABEL,
  outgoing,
  TEMPLATES,
  validateGraph,
  type NodeType,
  type WfGraph,
  type WfNode,
} from '../workflow/graph';

type Def = {
  id: string;
  name: string;
  status: 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'ARCHIVED';
  locationId: string | null;
  latestVersion: number;
  draftGraph: WfGraph;
  draftChecksum?: string;
  updatedAt: string;
  reviewRequestedByUserId?: string | null;
};
type Version = { id: string; version: number; graph: WfGraph; publishedByUserId: string; restoredFromVersion: number | null; note: string | null; createdAt: string };
type Step = { id: string; seq: number; nodeId: string; nodeType: string; status: string; durationMs: number };
type Run = { id: string; version: number; status: string; outcome: string | null; queryRedacted: string; startedByUserId: string; createdAt: string; suspendedExpiresAt?: string | null; steps?: Step[] };
type Preview = { status: string; verifiedSourceCount: number; references: Array<{ documentId: string; title: string; score: number }>; reviewReason?: string; trace: Array<{ nodeId: string; type: string; status: string; durationMs: number }> };

const BASE = '/ops/workflow-lab';
const NODE_TYPES = Object.keys(NODE_LABEL) as NodeType[];

export function WorkflowStudio({ locationId }: { locationId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="page">
      <h1>Workflow Studio</h1>
      <p className="muted">
        Design bounded, read-only assistant workflows. Nothing here sends messages, changes CRM records or runs customer-facing actions.
        Published versions are immutable; changes need an independent reviewer.
      </p>
      {openId ? <Editor id={openId} locationId={locationId} onBack={() => setOpenId(null)} /> : <Catalog locationId={locationId} onOpen={setOpenId} />}
    </div>
  );
}

function Catalog({ locationId, onOpen }: { locationId: string; onOpen: (id: string) => void }) {
  const defs = useAsync(() => api<Def[]>(`${BASE}/definitions`), []);
  const [name, setName] = useState('');
  const [tpl, setTpl] = useState(TEMPLATES[0].id);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setErr(null);
    try {
      const t = TEMPLATES.find((x) => x.id === tpl)!;
      const d = await api<Def>(`${BASE}/definitions`, { method: 'POST', body: JSON.stringify({ name: name.trim(), graph: t.graph, ...(locationId ? { locationId } : {}) }) });
      onOpen(d.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create workflow');
    }
  };
  const chosen = TEMPLATES.find((t) => t.id === tpl)!;
  return (
    <>
      <ErrorNote error={defs.error ?? err} />
      <Card title="New workflow">
        <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="stack">
          <label>Name<input value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} /></label>
          <label>Starting point
            <select value={tpl} onChange={(e) => setTpl(e.target.value)}>
              {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <p className="muted small">{chosen.description} Scope: {locationId ? 'selected rooftop' : 'all rooftops (tenant-wide)'}.</p>
          <button className="btn" type="submit" disabled={!name.trim()}>Create draft</button>
        </form>
      </Card>
      <Card title="Workflows">
        {defs.loading ? <p aria-busy="true">Loading…</p> : !defs.data?.length ? <Empty>No workflows yet.</Empty> : (
          <ul className="list" aria-label="Workflows">
            {defs.data.map((d) => (
              <li key={d.id}>
                <button className="linkish" onClick={() => onOpen(d.id)}>{d.name}</button>{' '}
                <Badge tone={statusTone(d.status)}>{d.status.replace('_', ' ')}</Badge>{' '}
                <span className="muted small">v{d.latestVersion || '—'} · updated {fmtDate(d.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Editor({ id, locationId, onBack }: { id: string; locationId: string; onBack: () => void }) {
  const me = session.user;
  const def = useAsync(() => api<Def>(`${BASE}/definitions/${id}`), [id]);
  const versions = useAsync(() => api<Version[]>(`${BASE}/definitions/${id}/versions`), [id]);
  const runs = useAsync(() => api<Run[]>(`${BASE}/runs?definitionId=${id}`), [id]);
  const [graph, setGraph] = useState<WfGraph | null>(null);
  const [name, setName] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (def.data) {
      setGraph(def.data.draftGraph);
      setName(def.data.name);
      setSel((s) => s ?? def.data!.draftGraph.nodes[0]?.id ?? null);
    }
  }, [def.data]);

  const issues = useMemo(() => (graph ? validateGraph(graph) : []), [graph]);
  const dirty = !!def.data && !!graph && (JSON.stringify(graph) !== JSON.stringify(def.data.draftGraph) || name !== def.data.name);
  const latest = versions.data?.[0] ?? null;
  const diff = useMemo(() => (graph ? diffGraphs(latest?.graph ?? null, graph) : []), [graph, latest]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setErr(null);
    setNote(null);
    setBusy(true);
    try {
      await fn();
      setNote(label);
      await Promise.all([def.reload(), versions.reload(), runs.reload()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  if (def.loading && !def.data) return <p aria-busy="true">Loading…</p>;
  if (!def.data || !graph) return (<><ErrorNote error={def.error ?? 'Workflow not found'} /><button className="btn btn--ghost" onClick={onBack}>Back to workflows</button></>);
  const d = def.data;
  const editable = d.status === 'DRAFT';
  const setNode = (n: WfNode) => setGraph({ ...graph, nodes: graph.nodes.map((x) => (x.id === n.id ? n : x)) });
  const selected = graph.nodes.find((n) => n.id === sel) ?? null;
  const issueFor = (nodeId: string) => issues.filter((i) => i.nodeId === nodeId);

  return (
    <>
      <p><button className="btn btn--ghost" onClick={onBack}>← All workflows</button></p>
      <ErrorNote error={def.error ?? err} />
      {note && <p role="status" className="muted">{note}</p>}
      <Card
        title={<>Workflow <Badge tone={statusTone(d.status)}>{d.status.replace('_', ' ')}</Badge> <span className="muted small">published v{d.latestVersion || '—'}</span></>}
        actions={<span className="muted small">Updated {fmtDate(d.updatedAt)}</span>}
      >
        <label>Name<input value={name} maxLength={120} disabled={!editable} onChange={(e) => setName(e.target.value)} /></label>
        {!editable && <p className="muted small">{d.status === 'IN_REVIEW' ? 'Awaiting independent review — editing is locked.' : 'Published workflows are edited by creating a new draft change; returning to draft requires saving an edit.'}</p>}
        <div className="row">
          <button className="btn" disabled={busy || !dirty || issues.length > 0 || !editable} onClick={() => void act('Draft saved', () => api(`${BASE}/definitions/${id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim(), graph }) }))}>Save draft</button>
          {d.status === 'PUBLISHED' && !dirty && <button className="btn btn--ghost" disabled={busy} onClick={() => void act('Draft reopened', () => api(`${BASE}/definitions/${id}`, { method: 'PATCH', body: JSON.stringify({ name: d.name }) }))}>Start new draft</button>}
          <button className="btn" disabled={busy || dirty || issues.length > 0 || d.status !== 'DRAFT'} onClick={() => void act('Submitted for review', () => api(`${BASE}/definitions/${id}/request-review`, { method: 'POST' }))}>Request review</button>
        </div>
        {dirty && <p className="muted small">Unsaved changes. Save before requesting review.</p>}
        {d.status === 'IN_REVIEW' && (
          <div className="stack" role="group" aria-label="Review decision">
            <p className="small">Reviewing checksum <code>{d.draftChecksum?.slice(0, 12)}…</code>. The server requires a reviewer who did not create, edit or request review of this draft.</p>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void act('Approved and published', () => api(`${BASE}/definitions/${id}/approve`, { method: 'POST', body: JSON.stringify({ reviewedChecksum: d.draftChecksum }) }))}>Approve and publish</button>
              <button className="btn btn--ghost" disabled={busy} onClick={() => void act('Returned to draft', () => api(`${BASE}/definitions/${id}/deny`, { method: 'POST' }))}>Deny</button>
            </div>
          </div>
        )}
      </Card>

      <Card title="Validation" >
        {issues.length === 0 ? <p role="status"><Badge tone="ok">Valid</Badge> This graph passes all checks.</p> : (
          <ul className="list" aria-label="Validation issues">
            {issues.map((i, n) => (
              <li key={n} className="error">
                {i.nodeId ? <button className="linkish" onClick={() => setSel(i.nodeId)}>{i.nodeId}</button> : <strong>Workflow</strong>}: {i.message}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="studio-grid">
        <Card title="Steps">
          <ol className="list" aria-label="Workflow steps">
            {graph.nodes.map((n) => (
              <li key={n.id}>
                <button className="linkish" aria-current={sel === n.id ? 'true' : undefined} onClick={() => setSel(n.id)}>
                  {n.id} — {NODE_LABEL[n.type]}
                </button>
                {issueFor(n.id).length > 0 && <Badge tone="bad">{issueFor(n.id).length} issue(s)</Badge>}
                {outgoing(n).filter(Boolean).length > 0 && <span className="muted small"> → {outgoing(n).filter(Boolean).join(', ')}</span>}
              </li>
            ))}
          </ol>
          {editable && (
            <div className="row">
              <label>Add step
                <select value="" onChange={(e) => { if (!e.target.value) return; const nn = newNode(e.target.value as NodeType, graph.nodes); setGraph({ ...graph, nodes: [...graph.nodes, nn] }); setSel(nn.id); }}>
                  <option value="">Choose a step type…</option>
                  {NODE_TYPES.filter((t) => t !== 'start').map((t) => <option key={t} value={t}>{NODE_LABEL[t]}</option>)}
                </select>
              </label>
            </div>
          )}
        </Card>

        <Card title="Inspector">
          {!selected ? <Empty>Select a step.</Empty> : (
            <Inspector node={selected} nodes={graph.nodes} editable={editable} onChange={setNode}
              onDelete={() => { setGraph({ ...graph, nodes: graph.nodes.filter((n) => n.id !== selected.id) }); setSel(graph.nodes[0]?.id ?? null); }} />
          )}
        </Card>
      </div>

      <Card title="Diagram">
        <Diagram graph={graph} sel={sel} onSelect={setSel} issues={issues.map((i) => i.nodeId)} />
        <p className="muted small">The list above is the keyboard and screen-reader equivalent of this diagram.</p>
      </Card>

      <Card title={latest ? `Changes since published v${latest.version}` : 'Changes (nothing published yet)'}>
        {diff.length === 0 ? <Empty>No differences.</Empty> : (
          <ul className="list" aria-label="Changes">
            {diff.map((e) => <li key={e.nodeId + e.kind}><Badge tone={e.kind === 'removed' ? 'bad' : e.kind === 'added' ? 'ok' : 'warn'}>{e.kind}</Badge> {e.nodeId} <span className="muted small">{e.detail}</span></li>)}
          </ul>
        )}
      </Card>

      <DryRun graph={graph} disabled={issues.length > 0} locationId={locationId || d.locationId || ''} />

      <Card title="Version history">
        {!versions.data?.length ? <Empty>No published versions.</Empty> : (
          <ul className="list" aria-label="Versions">
            {versions.data.map((v) => (
              <li key={v.id}>
                <strong>v{v.version}</strong> {fmtDate(v.createdAt)} {v.restoredFromVersion ? <Badge tone="info">restore of v{v.restoredFromVersion}</Badge> : null}
                {d.status !== 'IN_REVIEW' && d.status !== 'ARCHIVED' && v.version !== latest?.version && (
                  <button className="btn btn--ghost" disabled={busy} onClick={() => void act(`Rollback to v${v.version} submitted for review`, () => api(`${BASE}/definitions/${id}/rollback`, { method: 'POST', body: JSON.stringify({ toVersion: v.version }) }))}>Request rollback to this version</button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">A rollback never edits history: it opens a review request that an independent reviewer must approve.</p>
      </Card>

      <RunsPanel defId={id} runs={runs} hasVersion={!!latest} meId={me?.id ?? ''} onChanged={() => void runs.reload()} />
    </>
  );
}

function Inspector({ node, nodes, editable, onChange, onDelete }: { node: WfNode; nodes: WfNode[]; editable: boolean; onChange: (n: WfNode) => void; onDelete: () => void }) {
  const targets = nodes.filter((n) => n.id !== node.id);
  const pick = (label: string, value: string, set: (v: string) => void) => (
    <label>{label}
      <select value={value} disabled={!editable} onChange={(e) => set(e.target.value)}>
        <option value="">Choose a step…</option>
        {targets.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
      </select>
    </label>
  );
  return (
    <div className="stack">
      <p><strong>{node.id}</strong> <span className="muted small">{NODE_LABEL[node.type]}</span></p>
      {(node.type === 'start' || node.type === 'knowledge_search') && pick('Next step', node.next, (v) => onChange({ ...node, next: v }))}
      {node.type === 'knowledge_search' && (
        <label>Maximum sources (1–5)
          <input type="number" min={1} max={5} value={node.limit} disabled={!editable} onChange={(e) => onChange({ ...node, limit: Number(e.target.value) })} />
        </label>
      )}
      {node.type === 'branch_on_verified_sources' && (<>
        {pick('If verified sources were found, go to', node.whenFound, (v) => onChange({ ...node, whenFound: v }))}
        {pick('If none were found, go to', node.whenMissing, (v) => onChange({ ...node, whenMissing: v }))}
      </>)}
      {node.type === 'human_review' && (
        <label>Reason shown to the reviewer
          <textarea rows={3} maxLength={160} value={node.reason} disabled={!editable} onChange={(e) => onChange({ ...node, reason: e.target.value })} />
        </label>
      )}
      {node.type === 'knowledge_search' && <p className="muted small">Only published, customer-visible, in-date knowledge is searched.</p>}
      {editable && node.type !== 'start' && <button className="btn btn--ghost" onClick={onDelete}>Delete step</button>}
    </div>
  );
}

function Diagram({ graph, sel, onSelect, issues }: { graph: WfGraph; sel: string | null; onSelect: (id: string) => void; issues: Array<string | null> }) {
  const pos = layout(graph);
  const W = 170, H = 46, GX = 70, GY = 26;
  const xy = (id: string) => { const p = pos.get(id) ?? { col: 0, row: 0 }; return { x: 12 + p.col * (W + GX), y: 12 + p.row * (H + GY) }; };
  const cols = Math.max(0, ...[...pos.values()].map((p) => p.col)) + 1;
  const rows = Math.max(1, ...[...pos.values()].map((p) => p.row + 1));
  return (
    <div className="diagram" style={{ overflowX: 'auto' }}>
      <svg role="group" aria-label={`Workflow diagram with ${graph.nodes.length} steps`} width={cols * (W + GX)} height={rows * (H + GY) + 12}>
        <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor" /></marker></defs>
        {graph.nodes.flatMap((n) => outgoing(n).filter((t) => pos.has(t)).map((t, i) => {
          const a = xy(n.id), b = xy(t);
          return <line key={`${n.id}-${t}-${i}`} x1={a.x + W} y1={a.y + H / 2} x2={b.x} y2={b.y + H / 2} stroke="currentColor" strokeWidth={1.5} markerEnd="url(#arrow)" opacity={0.6} />;
        }))}
        {graph.nodes.map((n) => {
          const { x, y } = xy(n.id);
          const bad = issues.includes(n.id);
          return (
            <g key={n.id} tabIndex={0} role="button" aria-label={`${n.id}, ${NODE_LABEL[n.type]}${bad ? ', has issues' : ''}`} aria-pressed={sel === n.id}
              onClick={() => onSelect(n.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.id); } }}>
              <rect x={x} y={y} width={W} height={H} rx={8} fill="var(--card, #fff)" stroke={bad ? 'crimson' : 'currentColor'} strokeWidth={sel === n.id ? 3 : 1.25} />
              <text x={x + 10} y={y + 19} fontSize={12} fontWeight={600} fill="currentColor">{n.id}</text>
              <text x={x + 10} y={y + 35} fontSize={10} fill="currentColor" opacity={0.7}>{NODE_LABEL[n.type].slice(0, 28)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function DryRun({ graph, disabled, locationId }: { graph: WfGraph; disabled: boolean; locationId: string }) {
  const [q, setQ] = useState('What does the warranty cover?');
  const [res, setRes] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setErr(null); setBusy(true);
    try { setRes(await api<Preview>(`${BASE}/preview`, { method: 'POST', body: JSON.stringify({ graph, query: q, ...(locationId ? { locationId } : {}) }) })); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Preview failed'); setRes(null); }
    finally { setBusy(false); }
  };
  return (
    <Card title="Dry run (unsaved graph)">
      <p className="muted small">Uses published, customer-visible knowledge only. Dry runs are not stored and take no action.</p>
      <label>Test question<input value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} /></label>
      <button className="btn" disabled={disabled || busy || !q.trim()} onClick={() => void run()}>Run dry run</button>
      <ErrorNote error={err} />
      {res && (
        <div role="region" aria-label="Dry run result">
          <p><Badge tone={res.status === 'complete' ? 'ok' : 'warn'}>{res.status.replace(/_/g, ' ')}</Badge> {res.verifiedSourceCount} verified source(s){res.reviewReason ? ` — ${res.reviewReason}` : ''}</p>
          <ol className="list" aria-label="Trace">{res.trace.map((t, i) => <li key={i}>{t.nodeId} <span className="muted small">{t.type} · {t.status} · {t.durationMs}ms</span></li>)}</ol>
          {res.references.length > 0 && <ul className="list" aria-label="References">{res.references.map((r) => <li key={r.documentId}>{r.title} <span className="muted small">score {r.score.toFixed(2)}</span></li>)}</ul>}
        </div>
      )}
    </Card>
  );
}

function RunsPanel({ defId, runs, hasVersion, meId, onChanged }: { defId: string; runs: ReturnType<typeof useAsync<Run[]>>; hasVersion: boolean; meId: string; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Run | null>(null);
  const call = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); onChanged(); if (open) setOpen(await api<Run>(`${BASE}/runs/${open.id}`)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Request failed'); }
  };
  return (
    <Card title="Runs of the published version">
      <p className="muted small">Simulation only. A run that reaches a human-review step stays suspended until an independent person decides; expiry or silence is never approval.</p>
      <ErrorNote error={runs.error ?? err} />
      <form className="row" onSubmit={(e) => { e.preventDefault(); void call(async () => { const r = await api<Run>(`${BASE}/runs`, { method: 'POST', body: JSON.stringify({ definitionId: defId, query: q }) }); setOpen(r); setQ(''); }); }}>
        <label>Question<input value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} /></label>
        <button className="btn" type="submit" disabled={!hasVersion || !q.trim()}>Run published version</button>
      </form>
      {!hasVersion && <p className="muted small">Publish a version first.</p>}
      {!runs.data?.length ? <Empty>No runs yet.</Empty> : (
        <ul className="list" aria-label="Runs">
          {runs.data.map((r) => (
            <li key={r.id}>
              <button className="linkish" onClick={() => void api<Run>(`${BASE}/runs/${r.id}`).then(setOpen)}>v{r.version} · {fmtDate(r.createdAt)}</button>{' '}
              <Badge tone={statusTone(r.status)}>{r.status}</Badge> <span className="muted small">{r.outcome ?? ''} · “{r.queryRedacted}”</span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div role="region" aria-label="Run detail">
          <h3>Run trace <Badge tone={statusTone(open.status)}>{open.status}</Badge></h3>
          <ol className="list" aria-label="Run steps">{(open.steps ?? []).map((s) => <li key={s.id}>{s.seq + 1}. {s.nodeId} <span className="muted small">{s.nodeType} · {s.status} · {s.durationMs}ms</span></li>)}</ol>
          {open.status === 'SUSPENDED' && (
            <div className="row" role="group" aria-label="Run decision">
              {open.startedByUserId === meId ? <p className="muted small">You started this run, so someone else must decide it.</p> : (<>
                <button className="btn" onClick={() => void call(() => api(`${BASE}/runs/${open.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'APPROVE' }) }))}>Approve</button>
                <button className="btn btn--ghost" onClick={() => void call(() => api(`${BASE}/runs/${open.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'DENY' }) }))}>Deny</button>
              </>)}
              <button className="btn btn--ghost" onClick={() => void call(() => api(`${BASE}/runs/${open.id}/cancel`, { method: 'POST' }))}>Cancel run</button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
