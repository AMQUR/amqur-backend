import { useEffect, useState, type ReactNode } from 'react';
import { api, session, setActingTenant } from '../api';
import { KnowledgeTab } from './CrmWorkforceKnowledge';
import { AccessLogCard, ReportDeliveryCard, CostLimitsCard, DealershipSwitcher, GroupStopCard, PolicyCard, TeamTab, type MyDealerships } from './CrmWorkforceAdmin';
import { ago, fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, Stat } from '../ui';
import { DirectorCard, ImportsTab, MiningTab, PrivacyCard, ReportsCard, RosterCard, WorkItemsTab, WorkspaceTab } from './CrmWorkforceOps';
import {
  BASE, MODES, OPEN_TASK, QUEUES, actionLabel, actionTone, blockText, capabilityTone, countTasks, duration, inQueue, leadName, modeLabel,
  priorityLabel, sendingState, usd, vehicleText, workforceState,
  type Action, type Mode, type Overview, type QueueId, type Status, type Task,
} from '../crmwf/crmWorkforce';

type Tab = 'knowledge' | 'team' | 'workspace' | 'items' | 'mining' | 'imports' | 'overview' | 'queues' | 'drafts' | 'workforce' | 'controls' | 'compliance' | 'connections' | 'training' | 'performance' | 'audit';
const TABS: Array<{ id: Tab; label: string; managers?: boolean }> = [
  { id: 'workspace', label: 'Today' },
  { id: 'items', label: 'Appointments and follow-ups' },
  { id: 'mining', label: 'Lead recovery' },
  { id: 'knowledge', label: 'Store knowledge and inventory' },
  { id: 'overview', label: 'Overview' },
  { id: 'queues', label: 'Automation queue' },
  { id: 'drafts', label: 'Draft approvals' },
  { id: 'workforce', label: 'AI workforce' },
  { id: 'controls', label: 'Modes and kill switches' },
  { id: 'compliance', label: 'Compliance', managers: true },
  { id: 'imports', label: 'Data imports', managers: true },
  { id: 'connections', label: 'CRM connections and workers' },
  { id: 'training', label: 'Agent training', managers: true },
  { id: 'performance', label: 'Performance and costs', managers: true },
  { id: 'audit', label: 'Audit ledger', managers: true },
  { id: 'team', label: 'Team, limits and policy', managers: true },
];
const DEPTS = ['SALES', 'SERVICE', 'PARTS'] as const;
const post = <T,>(path: string, body: object = {}) => api<T>(`${BASE}/${path}`, { method: 'POST', body: JSON.stringify(body) });
const qs = (locationId: string, extra = '') => `${extra ? `${extra}&` : ''}${locationId ? `locationId=${encodeURIComponent(locationId)}` : ''}`;

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
      setMessage(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
      after();
    }
  }
  return { busy, act, note: <>{message && <p role="status">{message}</p>}<ErrorNote error={error} /></> };
}

/**
 * AMQUR CRM Workforce. Every number on these screens is a count of recorded events; an empty
 * section says it is empty. Synthetic records are labelled DEMO. Nothing here can turn on
 * customer sending by itself: that needs the deployment switch, the rooftop switch, an approved
 * identity, a verified CRM connection, consent and a counsel-approved policy — each shown here.
 */
export function CrmWorkforce({ locationId: homeLocationId }: { locationId: string }) {
  const mine = useAsync(() => api<MyDealerships>(`${BASE}/admin/my-dealerships`), []);
  const [tenantId, setTenantId] = useState('');
  useEffect(() => () => setActingTenant(null), []);
  const home = !tenantId || tenantId === mine.data?.homeTenantId;
  const dealer = mine.data?.dealerships.find((d) => d.tenantId === tenantId);
  // Acting in another group dealership: its role comes from the group membership.
  const homeRole = session.user?.role ?? 'STAFF';
  const role = home ? homeRole : mine.data?.groupRole === 'GROUP_ADMIN' && homeRole === 'ADMIN' ? 'ADMIN' : 'MANAGER';
  const isManager = role !== 'STAFF';
  const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const readOnlyGroup = !home && mine.data?.groupRole === 'GROUP_VIEWER';
  const locationId = home ? homeLocationId : dealer?.locations[0]?.id ?? '';
  const [tab, setTab] = useState<Tab>('workspace');
  const pick = (id: string) => {
    setActingTenant(id === mine.data?.homeTenantId ? null : id);
    setTenantId(id);
  };
  const status = useAsync(() => api<Status>(`${BASE}/status?${qs(locationId)}`), [locationId, tenantId]);
  const overview = useAsync(() => api<Overview>(`${BASE}/overview?${qs(locationId)}`), [locationId, tenantId]);
  const reload = () => {
    void status.reload();
    void overview.reload();
  };
  const stop = useAct(reload);
  const s = status.data;
  const state = s ? workforceState(s) : null;
  const tabs = TABS.filter((t) => !t.managers || isManager);

  return (
    <div className="page">
      <div className="row between">
        <h1>CRM Workforce{!home && dealer ? ` — ${dealer.name}` : ''}</h1>
        {mine.data && <DealershipSwitcher mine={mine.data} value={tenantId || mine.data.homeTenantId} onChange={pick} />}
        {s && locationId && !readOnlyGroup && (
          <button
            className="btn btn--danger"
            disabled={stop.busy}
            onClick={() => {
              const loc = s.controls.find((c) => c.scope === 'LOCATION' && c.locationId === locationId);
              const halting = !loc?.halted;
              if (!halting && !isManager) return;
              void stop.act(() => post('controls', { scope: 'LOCATION', locationId, halted: halting, reason: halting ? 'Stopped from Command Center' : 'Resumed from Command Center' }), halting ? 'This rooftop is stopped.' : 'This rooftop is resumed.');
            }}
          >
            {s.controls.find((c) => c.scope === 'LOCATION' && c.locationId === locationId)?.halted ? (isManager ? 'Resume this rooftop' : 'Rooftop stopped') : 'Stop this rooftop now'}
          </button>
        )}
      </div>
      <ErrorNote error={status.error ?? overview.error} />
      {stop.note}
      {state && (
        <p className={`banner ${state.tone === 'ok' ? 'banner--ok' : state.tone === 'neutral' ? '' : 'banner--warn'}`} role="status">
          <strong>{state.label}</strong> — {state.detail}{' '}
          {s && locationId && <Badge tone={sendingState(s, locationId).tone}>{sendingState(s, locationId).label}</Badge>}{' '}
          {overview.data && overview.data.dataLabel !== 'CRM DATA' && <Badge tone={overview.data.dataLabel === 'NO DATA' ? 'neutral' : 'info'}>{overview.data.dataLabel === 'DEMO' ? 'DEMO DATA — synthetic records' : overview.data.dataLabel === 'MIXED' ? 'Includes DEMO records' : 'No CRM data yet'}</Badge>}
        </p>
      )}
      <div className="row" role="tablist" aria-label="CRM Workforce sections">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'btn' : 'btn btn--ghost'} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div key={tenantId || 'home'}>
      {tab === 'knowledge' && <KnowledgeTab locationId={locationId} isManager={isManager && !readOnlyGroup} isAdmin={isAdmin && !readOnlyGroup} />}
      {tab === 'team' && mine.data && <GroupStopCard mine={mine.data} />}
      {tab === 'team' && <TeamTab isAdmin={isAdmin} actingRole={role} crossDealership={!home} locations={mine.data?.dealerships.find((d) => d.tenantId === (home ? mine.data?.homeTenantId : tenantId))?.locations ?? []} />}
      {tab === 'team' && <CostLimitsCard isAdmin={isAdmin} />}
      {tab === 'team' && isAdmin && <AccessLogCard />}
      {tab === 'team' && <ReportDeliveryCard locationId={locationId} />}
      {tab === 'team' && <PolicyCard />}
      {tab === 'workspace' && <WorkspaceTab locationId={locationId} isManager={isManager} />}
      {tab === 'items' && <WorkItemsTab locationId={locationId} />}
      {tab === 'mining' && <MiningTab locationId={locationId} />}
      {tab === 'imports' && <ImportsTab locationId={locationId} connected={!!s?.connectors.find((c) => c.adapterKey === 'export_import')?.connections.some((x) => x.locationId === locationId && x.enabled)} />}
      {tab === 'overview' && isManager && <DirectorCard locationId={locationId} />}
      {tab === 'overview' && <OverviewTab overview={overview.data} status={s} go={setTab} isManager={isManager} />}
      {tab === 'queues' && <QueuesTab locationId={locationId} />}
      {tab === 'drafts' && <DraftsTab locationId={locationId} isManager={isManager} />}
      {tab === 'workforce' && <RosterCard locationId={locationId} />}
      {tab === 'workforce' && <WorkforceTab locationId={locationId} isAdmin={isAdmin} />}
      {tab === 'controls' && s && <ControlsTab status={s} locationId={locationId} isManager={isManager} isAdmin={isAdmin} reload={reload} />}
      {tab === 'compliance' && <ComplianceTab isAdmin={isAdmin} />}
      {tab === 'compliance' && isAdmin && <PrivacyCard />}
      {tab === 'connections' && s && <ConnectionsTab status={s} locationId={locationId} isAdmin={isAdmin} reload={reload} />}
      {tab === 'training' && <TrainingTab locationId={locationId} />}
      {tab === 'performance' && <ReportsCard locationId={locationId} />}
      {tab === 'performance' && <PerformanceTab locationId={locationId} />}
      {tab === 'audit' && <AuditTab locationId={locationId} />}
      </div>
    </div>
  );
}

function OverviewTab({ overview: o, status: s, go, isManager }: { overview: Overview | null; status: Status | null; go: (t: Tab) => void; isManager: boolean }) {
  type GroupRow = { tenantId: string; name: string; featureFlag: boolean; mode: Mode; halted: boolean; externalSendEnabled: boolean; dataLabel: string; leads: { total: number }; tasks: Overview['tasks']; actions: Overview['actions']; connectors: Array<{ adapterKey: string; enabled: boolean; status: string }> };
  const group = useAsync(() => (isManager ? api<GroupRow[]>(`${BASE}/group`) : Promise.resolve([] as GroupRow[])), [isManager]);
  const open = (p: (t: Overview['tasks'][number]) => boolean) => countTasks(o, (t) => OPEN_TASK.includes(t.status) && p(t));
  const act = (st: string) => o?.actions.find((a) => a.status === st)?.count ?? 0;
  return (
    <div className="stack">
      <div className="stats">
        <Stat label="Customers waiting on a reply" value={open((t) => t.priority === 0)} />
        <Stat label="New leads, no response" value={open((t) => t.priority === 1)} />
        <Stat label="Appointment changes" value={open((t) => t.priority === 2)} />
        <Stat label="Recovery opportunities" value={open((t) => t.priority >= 4)} />
        <Stat label="Waiting for a person" value={countTasks(o, (t) => t.status === 'ESCALATED')} />
        <Stat label="Drafts to review" value={act('PENDING_APPROVAL') + act('DRAFT')} />
        <Stat label="Sent, confirmed in CRM" value={act('VERIFIED')} />
        <Stat label="Unknown result" value={act('UNCERTAIN') + act('SENT_UNVERIFIED')} hint="needs reconcile" />
        <Stat label="Suppressed contacts" value={o?.activeSuppressions ?? 0} />
        <Stat label="Paused leads" value={o?.pausedLeads ?? 0} />
      </div>
      <div className="grid2">
        <Card title="By department">
          {!o?.tasks.length ? <Empty>No work recorded yet.</Empty> : (
            <table className="table">
              <thead><tr><th>Department</th><th>Open</th><th>With a person</th><th>Done</th></tr></thead>
              <tbody>
                {DEPTS.map((d) => (
                  <tr key={d}>
                    <td>{d[0] + d.slice(1).toLowerCase()} BDC</td>
                    <td>{countTasks(o, (t) => t.department === d && OPEN_TASK.includes(t.status))}</td>
                    <td>{countTasks(o, (t) => t.department === d && t.status === 'ESCALATED')}</td>
                    <td>{countTasks(o, (t) => t.department === d && t.status === 'DONE')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Alerts" actions={<button className="btn btn--tiny btn--ghost" onClick={() => go('connections')}>Connections</button>}>
          <ul className="kv">
            <li><span>Failed or dead work</span><span><Badge tone={countTasks(o, (t) => t.status === 'DEAD' || t.status === 'FAILED') ? 'bad' : 'neutral'}>{countTasks(o, (t) => t.status === 'DEAD' || t.status === 'FAILED')}</Badge></span></li>
            <li><span>Sends with unknown result</span><span><Badge tone={act('UNCERTAIN') + act('SENT_UNVERIFIED') ? 'bad' : 'neutral'}>{act('UNCERTAIN') + act('SENT_UNVERIFIED')}</Badge></span></li>
            <li><span>Blocked sends</span><span><Badge tone={act('BLOCKED') ? 'warn' : 'neutral'}>{act('BLOCKED')}</Badge></span></li>
            <li><span>Workers reporting</span><span><Badge tone={s?.workers.some((w) => w.state === 'RUNNING') ? 'ok' : 'bad'}>{s?.workers.filter((w) => w.state === 'RUNNING').length ?? 0} running</Badge></span></li>
          </ul>
        </Card>
      </div>
      {isManager && <Card title="Group overview">
        <ErrorNote error={group.error} />
        {!group.data?.length ? <Empty>No rooftops to show.</Empty> : (
          <table className="table">
            <thead><tr><th>Dealership</th><th>State</th><th>Mode</th><th>Customer sending</th><th>Leads</th><th>Open work</th><th>CRM connection</th></tr></thead>
            <tbody>
              {group.data.map((g) => (
                <tr key={g.tenantId}>
                  <td>{g.name}</td>
                  <td><Badge tone={!g.featureFlag ? 'neutral' : g.halted ? 'bad' : 'ok'}>{!g.featureFlag ? 'off' : g.halted ? 'stopped' : 'enabled'}</Badge></td>
                  <td>{modeLabel(g.mode)}</td>
                  <td><Badge tone={g.externalSendEnabled ? 'warn' : 'neutral'}>{g.externalSendEnabled ? 'rooftop switch on' : 'off'}</Badge></td>
                  <td>{g.leads.total}{g.dataLabel === 'DEMO' && <> <Badge tone="info">demo</Badge></>}</td>
                  <td>{g.tasks.filter((t) => OPEN_TASK.includes(t.status)).reduce((n, t) => n + t.count, 0)}</td>
                  <td>{g.connectors.filter((c) => c.enabled).map((c) => <Badge key={c.adapterKey} tone={c.status === 'READY' ? 'ok' : 'warn'}>{c.adapterKey.replace(/_/g, ' ')}: {c.status.toLowerCase()}</Badge>)}{!g.connectors.some((c) => c.enabled) && <span className="muted">not connected</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>}
    </div>
  );
}

function QueuesTab({ locationId }: { locationId: string }) {
  const [queue, setQueue] = useState<QueueId>('inbound');
  const [dept, setDept] = useState('');
  const def = QUEUES.find((q) => q.id === queue)!;
  const list = useAsync(() => api<Task[]>(`${BASE}/tasks?${qs(locationId, `${def.query}${dept ? `&department=${dept}` : ''}`)}`), [queue, dept, locationId]);
  const a = useAct(() => void list.reload());
  const rows = (list.data ?? []).filter((t) => inQueue(queue, t));
  return (
    <div className="stack">
      <div className="row" role="group" aria-label="Queue">
        {QUEUES.map((q) => <button key={q.id} className={q.id === queue ? 'btn' : 'btn btn--ghost'} aria-pressed={q.id === queue} onClick={() => setQueue(q.id)}>{q.label}</button>)}
        <label className="small">Department{' '}
          <select value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">All</option>
            {DEPTS.map((d) => <option key={d} value={d}>{d[0] + d.slice(1).toLowerCase()} BDC</option>)}
          </select>
        </label>
      </div>
      <ErrorNote error={list.error} />
      {a.note}
      {list.loading && !list.data ? <p aria-busy="true">Loading…</p> : !rows.length ? <Empty>{def.empty}</Empty> : (
        <table className="table">
          <thead><tr><th>Customer</th><th>Why it is here</th><th>Owner</th><th>Status</th><th>Since</th><th></th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>{leadName(t.lead)}{t.lead?.synthetic && <> <Badge tone="info">demo</Badge></>}<div className="muted small">{vehicleText(t.lead)}{t.lead?.leadSource ? ` · ${t.lead.leadSource}` : ''}</div></td>
                <td>{priorityLabel(t.priority)}<div className="muted small">{(t.evidence.rules ?? []).map((r) => r.rule).join(', ')}{t.evidence.signals?.length ? ` · ${t.evidence.signals.join(', ').toLowerCase().replace(/_/g, ' ')}` : ''}</div></td>
                <td>{t.lead?.assignedTo ?? <span className="muted">unassigned</span>}</td>
                <td><Badge tone={t.status === 'ESCALATED' ? 'warn' : t.status === 'DEAD' ? 'bad' : 'neutral'}>{t.status.replace(/_/g, ' ').toLowerCase()}</Badge><div className="muted small">{(t.statusReason ?? t.lastError ?? '').replace(/_/g, ' ')}</div></td>
                <td>{ago(t.createdAt)}</td>
                <td><button className="btn btn--tiny btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`leads/${t.crmLeadId}/takeover`, { reason: 'Taken over from the queue' }), 'You have this customer. The virtual team is paused on this lead.')}>I’ll take it</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DraftsTab({ locationId, isManager }: { locationId: string; isManager: boolean }) {
  const [filter, setFilter] = useState('PENDING_APPROVAL,DRAFT');
  const list = useAsync(() => api<Action[]>(`${BASE}/actions?${qs(locationId, `status=${filter}`)}`), [filter, locationId]);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const a = useAct(() => void list.reload());
  const FILTERS = [['PENDING_APPROVAL,DRAFT', 'To review'], ['UNCERTAIN,SENT_UNVERIFIED', 'Unknown result'], ['BLOCKED,FAILED', 'Blocked or failed'], ['VERIFIED,STAFF_CONFIRMED', 'Sent'], ['REJECTED,CANCELLED', 'Not sent']];
  return (
    <div className="stack">
      <div className="row" role="group" aria-label="Filter drafts">
        {FILTERS.map(([id, label]) => <button key={id} className={id === filter ? 'btn' : 'btn btn--ghost'} aria-pressed={id === filter} onClick={() => setFilter(id)}>{label}</button>)}
      </div>
      <ErrorNote error={list.error} />
      {a.note}
      {list.loading && !list.data ? <p aria-busy="true">Loading…</p> : !list.data?.length ? <Empty>Nothing here.</Empty> : list.data.map((r) => {
        const body = edit[r.id] ?? r.payload.body ?? '';
        const d = r.complianceDecision;
        return (
          <Card key={r.id} title={<>{leadName(r.lead)} <span className="muted small">{r.channel} · {r.payload.identity} · {(r.payload.workflow ?? '').replace(/_/g, ' ')}</span></>} actions={<span className="row">{r.lead?.synthetic && <Badge tone="info">demo</Badge>}<Badge tone={actionTone(r.status)}>{actionLabel(r.status)}</Badge></span>}>
            {r.status === 'PENDING_APPROVAL' && isManager ? (
              <label className="small">Message to the customer
                <textarea rows={3} maxLength={900} value={body} onChange={(e) => setEdit({ ...edit, [r.id]: e.target.value })} />
              </label>
            ) : <p>{r.payload.body}</p>}
            <p className="muted small">
              Written {ago(r.createdAt)} from playbook {r.playbookKey} v{r.playbookVersion}.{' '}
              {r.payload.facts?.length ? `Facts used: ${r.payload.facts.map((f) => `${f.kind} (as of ${fmtDate(f.asOf)})`).join('; ')}.` : 'No dealership facts were available, so the message states none.'}
              {r.statusReason && ` Reason: ${r.statusReason.replace(/_/g, ' ')}.`}
            </p>
            {d && !d.sendAllowed && (
              <div className="banner banner--warn small">
                <strong>The system cannot send this.</strong>
                <ul>{d.blocks.map((b, i) => <li key={i}>{blockText(b)}</li>)}</ul>
              </div>
            )}
            <span className="row">
              {r.status === 'PENDING_APPROVAL' && isManager && <button className="btn" disabled={a.busy} onClick={() => void a.act(() => post(`actions/${r.id}/approve`, body !== r.payload.body ? { body } : {}), 'Approved. See the status for the result.')}>{d && !d.sendAllowed ? 'Re-check and send if allowed' : 'Approve and send'}</button>}
              {(r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL') && <button className="btn btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`actions/${r.id}/staff-confirm`, {}), 'Recorded as sent by you in the CRM.')}>I sent this myself in the CRM</button>}
              {(r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL') && <button className="btn btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`actions/${r.id}/reject`, { reason: 'Rejected in review' }), 'Rejected. Nothing was sent.')}>Reject</button>}
              {(r.status === 'UNCERTAIN' || r.status === 'SENT_UNVERIFIED') && isManager && <button className="btn" disabled={a.busy} onClick={() => void a.act(() => post(`actions/${r.id}/reconcile`), 'Checked the CRM.')}>Check the CRM for this message</button>}
              {r.crmLeadId && (r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL') && <button className="btn btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`leads/${r.crmLeadId}/takeover`, { reason: 'Taken over from draft review' }), 'You have this customer. The draft was cancelled.')}>I’ll take this customer</button>}
            </span>
            {isManager && ['VERIFIED', 'STAFF_CONFIRMED', 'REJECTED'].includes(r.status) && <ReviewRow actionId={r.id} />}
          </Card>
        );
      })}
    </div>
  );
}

function ReviewRow({ actionId }: { actionId: string }) {
  const [done, setDone] = useState(false);
  const a = useAct(() => undefined);
  if (done) return <p className="muted small" role="status">Review saved.</p>;
  return (
    <span className="row small">
      <span className="muted">Rate this reply:</span>
      {[['good', 5, 'Good'], ['too_long', 2, 'Too long'], ['wrong_tone', 2, 'Wrong tone'], ['wrong_fact', 1, 'Wrong fact'], ['should_escalate', 1, 'Should have gone to a person']].map(([label, score, text]) => (
        <button key={String(label)} className="btn btn--tiny btn--ghost" disabled={a.busy} onClick={() => void a.act(async () => { await post('reviews', { actionId, score, label }); setDone(true); }, '')}>{text}</button>
      ))}
      {a.note}
    </span>
  );
}

function WorkforceTab({ locationId, isAdmin }: { locationId: string; isAdmin: boolean }) {
  type Profile = { id: string; locationId: string; department: string; displayName: string; title: string; disclosure: string; active: boolean; version: number };
  type Agents = { profiles: Profile[]; playbooks: Array<{ key: string; version: number; agent: string; workflows: string[]; escalate: string[]; checksum: string }> };
  const agents = useAsync(() => api<Agents>(`${BASE}/agents?${qs(locationId)}`), [locationId]);
  const [form, setForm] = useState({ department: 'SALES', displayName: '', title: 'Virtual BDC Manager', disclosure: '' });
  const a = useAct(() => void agents.reload());
  return (
    <div className="stack">
      <ErrorNote error={agents.error} />
      <Card title="Virtual identities">
        <p className="muted small">Each department speaks as one named virtual representative. It always identifies itself as virtual and never uses an employee’s name.</p>
        {!agents.data?.profiles.length ? <Empty>No identity is set for this rooftop. Without one, nothing can be sent.</Empty> : (
          <table className="table">
            <thead><tr><th>Department</th><th>Name</th><th>Title</th><th>How it introduces itself</th><th>State</th></tr></thead>
            <tbody>{agents.data.profiles.map((p) => <tr key={p.id}><td>{p.department}</td><td>{p.displayName}</td><td>{p.title}</td><td>{p.disclosure}</td><td><Badge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'active' : 'inactive'}</Badge> <span className="muted small">v{p.version}</span></td></tr>)}</tbody>
          </table>
        )}
        {isAdmin && locationId && (
          <div className="row">
            <label className="small">Department<select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>{DEPTS.map((d) => <option key={d}>{d}</option>)}</select></label>
            <label className="small">Name<input maxLength={40} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
            <label className="small">Title<input maxLength={80} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label className="small">Introduction<input maxLength={200} placeholder="Sarah, the virtual BDC manager at …" value={form.disclosure} onChange={(e) => setForm({ ...form, disclosure: e.target.value })} /></label>
            <button className="btn" disabled={a.busy || !form.displayName || !form.disclosure} onClick={() => void a.act(() => post('agents/profile', { ...form, locationId }), 'Identity saved.')}>Save identity</button>
          </div>
        )}
        {isAdmin && !locationId && <p className="muted small">Choose a rooftop to edit its identities.</p>}
        {a.note}
      </Card>
      <Card title="Agents and playbooks">
        <p className="muted small">Playbooks are versioned and change only through a reviewed release. Agents cannot edit them, their permissions or the communication policy.</p>
        <table className="table">
          <thead><tr><th>Agent</th><th>Playbook</th><th>Handles</th><th>Always hands to a person</th></tr></thead>
          <tbody>{(agents.data?.playbooks ?? []).map((p) => <tr key={p.key}><td>{p.agent.replace(/_/g, ' ')}</td><td>{p.key} v{p.version} <code className="small">{p.checksum}</code></td><td>{p.workflows.map((w) => w.replace(/_/g, ' ')).join(', ')}</td><td>{p.escalate.join('; ')}</td></tr>)}</tbody>
        </table>
      </Card>
    </div>
  );
}

function ControlsTab({ status: s, locationId, isManager, isAdmin, reload }: { status: Status; locationId: string; isManager: boolean; isAdmin: boolean; reload: () => void }) {
  const a = useAct(reload);
  const [person, setPerson] = useState('');
  const loc = s.controls.find((c) => c.scope === 'LOCATION' && c.locationId === locationId);
  const set = (body: object, done: string) => void a.act(() => post('controls', { locationId: locationId || undefined, ...body }), done);
  const row = (scope: string, key?: string) => s.controls.find((c) => c.scope === scope && c.locationId === locationId && (scope === 'DEPARTMENT' ? c.department === key : c.subjectKey === key));
  return (
    <div className="stack">
      {a.note}
      <Card title="Deployment switches">
        <ul className="kv">
          <li><span>Workforce engine</span><span><Badge tone={s.processEnabled ? 'ok' : 'neutral'}>{s.processEnabled ? 'on' : 'off'}</Badge></span></li>
          <li><span>Customer sending for this deployment</span><span><Badge tone={s.externalSendEnv ? 'warn' : 'neutral'}>{s.externalSendEnv ? 'on' : 'off'}</Badge></span></li>
          <li><span>Emergency stop (all dealerships)</span><span><Badge tone={s.globalHalted || s.emergencyStopEnv ? 'bad' : 'neutral'}>{s.globalHalted || s.emergencyStopEnv ? 'STOPPED' : 'not active'}</Badge></span></li>
        </ul>
        <p className="muted small">These are set by the platform operator outside this screen. The stops below work immediately and do not depend on the AI.</p>
      </Card>
      {!locationId ? <Empty>Choose a rooftop to see and change its mode, kill switches and pauses.</Empty> : (
        <>
          <Card title="Operating mode" actions={<Badge tone="info">{modeLabel(loc?.mode)}</Badge>}>
            <table className="table">
              <tbody>{MODES.map((m) => (
                <tr key={m.id}>
                  <td><strong>{m.label}</strong><div className="muted small">{m.what}</div></td>
                  <td>{(loc?.mode ?? 'OBSERVE') === m.id ? <Badge tone="ok">current</Badge> : (m.id === 'OBSERVE' || (isManager && m.id !== 'CONTROLLED_AUTONOMOUS') || isAdmin) && m.id !== 'CONTROLLED_AUTONOMOUS' ? <button className="btn btn--tiny btn--ghost" disabled={a.busy} onClick={() => set({ scope: 'LOCATION', mode: m.id, reason: `Mode set to ${m.label}` }, `Mode is now ${m.label}.`)}>Switch to this</button> : <span className="muted small">{m.id === 'CONTROLLED_AUTONOMOUS' ? 'Needs a written authorisation per workflow' : 'Managers only'}</span>}</td>
                </tr>
              ))}</tbody>
            </table>
            <p className="small">Rooftop customer-sending switch: <Badge tone={loc?.externalSendEnabled ? 'warn' : 'neutral'}>{loc?.externalSendEnabled ? 'on' : 'off'}</Badge>{' '}
              {isAdmin && <button className="btn btn--tiny btn--ghost" disabled={a.busy} onClick={() => set({ scope: 'LOCATION', externalSendEnabled: !loc?.externalSendEnabled, reason: loc?.externalSendEnabled ? 'Sending switched off' : 'Sending switched on by administrator' }, 'Updated.')}>{loc?.externalSendEnabled ? 'Switch off' : 'Switch on'}</button>}
            </p>
          </Card>
          <Card title="Kill switches and pauses">
            <table className="table">
              <thead><tr><th>Scope</th><th>State</th><th></th></tr></thead>
              <tbody>
                <tr><td>Whole rooftop</td><td><Badge tone={loc?.halted ? 'bad' : 'neutral'}>{loc?.halted ? 'stopped' : 'running'}</Badge></td><td><Toggle halted={!!loc?.halted} can={isManager} busy={a.busy} on={(h) => set({ scope: 'LOCATION', halted: h, reason: h ? 'Rooftop stopped' : 'Rooftop resumed' }, 'Updated.')} /></td></tr>
                {DEPTS.map((d) => { const r = row('DEPARTMENT', d); return <tr key={d}><td>{d[0] + d.slice(1).toLowerCase()} BDC</td><td><Badge tone={r?.halted ? 'bad' : 'neutral'}>{r?.halted ? 'stopped' : 'running'}</Badge></td><td><Toggle halted={!!r?.halted} can={isManager} busy={a.busy} on={(h) => set({ scope: 'DEPARTMENT', department: d, halted: h, reason: h ? `${d} stopped` : `${d} resumed` }, 'Updated.')} /></td></tr>; })}
                {s.controls.filter((c) => c.locationId === locationId && (c.scope === 'WORKFLOW' || c.scope === 'SALESPERSON')).map((c) => <tr key={c.id}><td>{c.scope === 'WORKFLOW' ? 'Workflow' : 'Salesperson'}: {c.subjectKey?.replace(/_/g, ' ')}</td><td><Badge tone={c.halted ? 'bad' : 'neutral'}>{c.halted ? 'paused' : 'running'}</Badge></td><td><Toggle halted={c.halted} can={isManager} busy={a.busy} on={(h) => set({ scope: c.scope, subjectKey: c.subjectKey, halted: h, reason: h ? 'Paused' : 'Resumed' }, 'Updated.')} /></td></tr>)}
              </tbody>
            </table>
            <div className="row">
              <label className="small">Pause a salesperson’s leads<input maxLength={120} placeholder="Name as shown in the CRM" value={person} onChange={(e) => setPerson(e.target.value)} /></label>
              <button className="btn btn--ghost" disabled={a.busy || person.trim().length < 2} onClick={() => { set({ scope: 'SALESPERSON', subjectKey: person.trim(), halted: true, reason: 'Salesperson paused' }, 'Paused.'); setPerson(''); }}>Pause</button>
            </div>
            <p className="muted small">Anyone on staff can stop. Only a manager can resume.</p>
          </Card>
        </>
      )}
    </div>
  );
}
function Toggle({ halted, can, busy, on }: { halted: boolean; can: boolean; busy: boolean; on: (h: boolean) => void }): ReactNode {
  if (halted) return can ? <button className="btn btn--tiny btn--ghost" disabled={busy} onClick={() => on(false)}>Resume</button> : <span className="muted small">A manager can resume</span>;
  return <button className="btn btn--tiny btn--danger" disabled={busy} onClick={() => on(true)}>Stop</button>;
}

function ComplianceTab({ isAdmin }: { isAdmin: boolean }) {
  type Sup = { id: string; channel: string; endpoint: string; reason: string; source: string; createdAt: string; liftedAt: string | null };
  const list = useAsync(() => api<Sup[]>(`${BASE}/suppressions`), []);
  const a = useAct(() => void list.reload());
  return (
    <div className="stack">
      <Card title="Checked before every customer message">
        <p className="small">These checks run in code, outside the AI, when a draft is written and again at the moment of sending: kill switches · suppression list · CRM do-not-contact · channel-specific consent on record · consent age for marketing · human owner · open duplicate · customer’s contact hours · daily and weekly limits · unanswered-attempt limit · lead-source restrictions · approved virtual identity · verified CRM channel · counsel-approved policy.</p>
        <p className="muted small">A phone number or an old CRM record is not consent. Records without consent on file are not contacted; they appear under Conversations and queues → Consent review.</p>
      </Card>
      <Card title="Suppression list">
        <ErrorNote error={list.error} />
        {a.note}
        {!list.data?.length ? <Empty>No suppressed contacts.</Empty> : (
          <table className="table">
            <thead><tr><th>Contact</th><th>Applies to</th><th>Reason</th><th>From</th><th>When</th><th></th></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.id}>
                <td>{r.endpoint}</td><td>{r.channel === 'ALL' ? 'Every channel' : r.channel}</td><td>{r.reason.replace(/_/g, ' ').toLowerCase()}</td><td>{r.source.replace(/_/g, ' ').toLowerCase()}</td><td>{fmtDate(r.createdAt)}</td>
                <td>{r.liftedAt ? <Badge>lifted</Badge> : r.source === 'INBOUND_MESSAGE' ? <span className="muted small">Only the customer can undo this</span> : isAdmin ? <button className="btn btn--tiny btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`suppressions/${r.id}/lift`, { reason: 'Lifted by administrator' }), 'Suppression lifted.')}>Lift</button> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function ConnectionsTab({ status: s, locationId, isAdmin, reload }: { status: Status; locationId: string; isAdmin: boolean; reload: () => void }) {
  const a = useAct(reload);
  const [ref, setRef] = useState('');
  return (
    <div className="stack">
      {a.note}
      <Card title="Workers">
        {!s.workers.length ? <Empty>No worker has reported in. Queued work is not being processed.</Empty> : (
          <table className="table"><thead><tr><th>Worker</th><th>State</th><th>Last heartbeat</th><th>Started</th></tr></thead>
            <tbody>{s.workers.map((w) => <tr key={w.workerId}><td>{w.workerId}</td><td><Badge tone={w.state === 'RUNNING' ? 'ok' : w.state === 'DOWN' ? 'bad' : 'warn'}>{w.state.replace(/_/g, ' ').toLowerCase()}</Badge></td><td>{ago(w.lastBeatAt)}</td><td>{fmtDate(w.startedAt)}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
      {s.connectors.map((c) => {
        const conn = c.connections.find((x) => x.locationId === locationId);
        const blocked = c.capabilities.every((x) => x.status === 'BLOCKED');
        const reason = c.capabilities.find((x) => x.reason)?.reason;
        return (
          <Card key={c.adapterKey} title={c.label} actions={<Badge tone={conn?.enabled ? (conn.status === 'READY' ? 'ok' : 'warn') : blocked ? 'warn' : 'neutral'}>{conn?.enabled ? conn.status.replace(/_/g, ' ').toLowerCase() : blocked ? 'blocked' : 'not connected'}</Badge>}>
            {blocked && <p className="banner banner--warn small">Not available: {(reason ?? '').replace(/_/g, ' ')}. This connector cannot read or write the CRM and cannot be switched on from here.</p>}
            {conn && <p className="muted small">{conn.authorizationRef ? `Authorisation on record: ${conn.authorizationRef} (${fmtDate(conn.authorizedAt)}). ` : ''}Last check {ago(conn.lastHealthAt)}{conn.lastSyncAt ? ` · last sync ${ago(conn.lastSyncAt)}` : ''}{conn.lastError ? ` · last error: ${conn.lastError}` : ''}</p>}
            <details>
              <summary className="small">What this connection can do ({c.capabilities.filter((x) => x.status !== 'BLOCKED').length} of {c.capabilities.length})</summary>
              <table className="table">
                <thead><tr><th>Operation</th><th>Kind</th><th>Status</th></tr></thead>
                <tbody>{c.capabilities.map((x) => <tr key={x.operation}><td>{x.operation}</td><td>{x.sideEffect === 'READ_ONLY' ? 'read only' : x.sideEffect === 'DRAFT_ONLY' ? 'draft only' : 'external write'}</td><td><Badge tone={capabilityTone(x.status)}>{x.status}</Badge>{x.reason && <span className="muted small"> {x.reason.replace(/_/g, ' ')}</span>}</td></tr>)}</tbody>
              </table>
            </details>
            {isAdmin && locationId && !blocked && (
              <span className="row">
                {c.requiresAuthorization && !conn?.enabled && <label className="small">Written authorisation reference<input maxLength={200} value={ref} onChange={(e) => setRef(e.target.value)} /></label>}
                <button className="btn btn--ghost" disabled={a.busy || (!conn?.enabled && c.requiresAuthorization && ref.trim().length < 3)} onClick={() => void a.act(() => post('connectors', { locationId, adapterKey: c.adapterKey, enabled: !conn?.enabled, authorizationRef: ref.trim() || undefined }), conn?.enabled ? 'Disconnected.' : 'Connected.')}>{conn?.enabled ? 'Disconnect' : 'Connect'}</button>
              </span>
            )}
            {c.adapterKey === 'export_import' && conn?.enabled && <p className="muted small">Upload exports under Data imports.</p>}
          </Card>
        );
      })}
    </div>
  );
}

function TrainingTab({ locationId }: { locationId: string }) {
  type Reviews = { rows: Array<{ id: string; label: string; score: number; note: string | null; correctedBody: string | null; createdAt: string }>; byLabel: Array<{ label: string; count: number; avgScore: number | null }> };
  const r = useAsync(() => api<Reviews>(`${BASE}/reviews?${qs(locationId)}`), [locationId]);
  return (
    <div className="stack">
      <ErrorNote error={r.error} />
      <Card title="Manager reviews">
        <p className="muted small">Rate replies under Draft approvals → Sent. Reviews feed the evaluation set with contact details removed. They do not change how agents behave on their own: behaviour changes ship as a new playbook version after evaluation and approval.</p>
        {!r.data?.byLabel.length ? <Empty>No replies have been reviewed yet.</Empty> : (
          <table className="table"><thead><tr><th>Finding</th><th>Count</th><th>Average score</th></tr></thead>
            <tbody>{r.data.byLabel.map((b) => <tr key={b.label}><td>{b.label.replace(/_/g, ' ')}</td><td>{b.count}</td><td>{b.avgScore === null ? '—' : b.avgScore.toFixed(1)}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
      {!!r.data?.rows.length && <Card title="Recent reviews"><ul className="list">{r.data.rows.slice(0, 20).map((x) => <li key={x.id}><span>{x.label.replace(/_/g, ' ')} · {x.score}/5{x.note ? ` · ${x.note}` : ''}</span><span className="muted small">{ago(x.createdAt)}</span></li>)}</ul></Card>}
    </div>
  );
}

function PerformanceTab({ locationId }: { locationId: string }) {
  type Perf = { note: string; eligibleLeads: Array<{ department: string; leadSource: string | null; count: number }>; tasks: Array<{ department: string; status: string; count: number }>; externalActions: Array<{ department: string | null; status: string; count: number }>; outcomes: Array<{ department: string; kind: string; basis: string; verified: boolean; count: number }>; humanEscalations: number; duplicateSends: number; blockedExecutions: number; firstResponse: Array<{ department: string; count: number; avgSeconds: number | null }> };
  type Costs = { note: string; modelCostMicroUsd: number; calls: Array<{ kind: string; provider: string | null; model: string | null; calls: number; inputTokens: number; outputTokens: number; costMicroUsd: number }>; unitCostMicroUsd: Record<string, number | null> };
  const [days, setDays] = useState('30');
  const p = useAsync(() => api<Perf>(`${BASE}/performance?${qs(locationId, `days=${days}`)}`), [locationId, days]);
  const c = useAsync(() => api<Costs>(`${BASE}/costs?${qs(locationId, `days=${days}`)}`), [locationId, days]);
  const sum = (rows: Array<{ count: number }> | undefined) => (rows ?? []).reduce((n, r) => n + r.count, 0);
  const acts = (st: string) => sum(p.data?.externalActions.filter((a) => a.status === st));
  const UNIT: Array<[string, string]> = [['perProcessedLead', 'Per processed lead'], ['perConversation', 'Per conversation'], ['perQualifiedOpportunity', 'Per qualified opportunity'], ['perAppointment', 'Per appointment'], ['perShownAppointment', 'Per shown appointment'], ['perAttributedSale', 'Per attributed sale']];
  return (
    <div className="stack">
      <div className="row"><label className="small">Period<select value={days} onChange={(e) => setDays(e.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select></label></div>
      <ErrorNote error={p.error ?? c.error} />
      {p.data && <p className="muted small">{p.data.note}</p>}
      <div className="stats">
        <Stat label="Leads read from the CRM" value={sum(p.data?.eligibleLeads)} />
        <Stat label="Tasks worked" value={sum(p.data?.tasks.filter((t) => ['DONE', 'AWAITING_APPROVAL', 'ESCALATED', 'SUPPRESSED'].includes(t.status)))} />
        <Stat label="Messages confirmed sent" value={acts('VERIFIED')} />
        <Stat label="Sent by employees" value={acts('STAFF_CONFIRMED')} />
        <Stat label="Handed to a person" value={p.data?.humanEscalations ?? 0} />
        <Stat label="Sends blocked by policy" value={p.data?.blockedExecutions ?? 0} />
        <Stat label="Duplicate sends" value={p.data?.duplicateSends ?? 0} hint="expected: 0" />
        <Stat label="Failed operations" value={acts('FAILED') + sum(p.data?.tasks.filter((t) => t.status === 'DEAD'))} />
      </div>
      <div className="grid2">
        <Card title="Outcomes">
          {!p.data?.outcomes.length ? <Empty>No outcomes recorded in this period. This means no data, not zero results.</Empty> : (
            <table className="table"><thead><tr><th>Department</th><th>Outcome</th><th>Basis</th><th>Source</th><th>Count</th></tr></thead>
              <tbody>{p.data.outcomes.map((o, i) => <tr key={i}><td>{o.department}</td><td>{o.kind === 'DEAL_CREATED' ? 'Deal record created (not a verified sale)' : o.kind.replace(/_/g, ' ').toLowerCase()}</td><td>{o.basis.toLowerCase()}</td><td><Badge tone={o.verified ? 'ok' : 'info'}>{o.verified ? 'from CRM' : 'demo'}</Badge></td><td>{o.count}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
        <Card title="First response time">
          {!p.data?.firstResponse.length ? <Empty>No confirmed first responses yet.</Empty> : <ul className="kv">{p.data.firstResponse.map((f) => <li key={f.department}><span>{f.department} ({f.count})</span><span>{duration(f.avgSeconds)}</span></li>)}</ul>}
        </Card>
        <Card title="Leads by source">
          {!p.data?.eligibleLeads.length ? <Empty>No leads in this period.</Empty> : <ul className="kv">{p.data.eligibleLeads.map((e, i) => <li key={i}><span>{e.department} · {e.leadSource ?? 'unknown source'}</span><span>{e.count}</span></li>)}</ul>}
        </Card>
        <Card title="Operating costs" actions={<Badge tone="info">{usd(c.data?.modelCostMicroUsd ?? 0)} model cost</Badge>}>
          {c.data && <p className="muted small">{c.data.note}</p>}
          <ul className="kv">{UNIT.map(([k, label]) => <li key={k}><span>{label}</span><span>{usd(c.data?.unitCostMicroUsd[k] ?? null)}</span></li>)}</ul>
          {!!c.data?.calls.length && <table className="table"><thead><tr><th>Use</th><th>Model</th><th>Calls</th><th>Tokens in / out</th><th>Cost</th></tr></thead><tbody>{c.data.calls.map((x, i) => <tr key={i}><td>{x.kind}</td><td>{x.model ?? '—'}</td><td>{x.calls}</td><td>{x.inputTokens} / {x.outputTokens}</td><td>{usd(x.costMicroUsd)}</td></tr>)}</tbody></table>}
        </Card>
      </div>
    </div>
  );
}

function AuditTab({ locationId }: { locationId: string }) {
  type Row = { id: string; action: string; resource: string | null; resourceId: string | null; metadata: Record<string, unknown> | null; userId: string | null; createdAt: string };
  const list = useAsync(() => api<Row[]>(`${BASE}/audit?${qs(locationId)}`), [locationId]);
  return (
    <Card title="Audit ledger">
      <ErrorNote error={list.error} />
      {!list.data?.length ? <Empty>No recorded activity yet.</Empty> : (
        <table className="table">
          <thead><tr><th>When</th><th>What</th><th>By</th><th>Details</th></tr></thead>
          <tbody>{list.data.map((r) => <tr key={r.id}><td>{fmtDate(r.createdAt)}</td><td>{r.action.replace(/^crmwf\./, '').replace(/[._]/g, ' ')}</td><td>{r.userId ? 'staff' : 'system'}</td><td className="small muted">{r.metadata ? Object.entries(r.metadata).filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => `${k}: ${String(v)}`).join(' · ') : ''}</td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}
