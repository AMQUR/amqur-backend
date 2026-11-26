import { useState } from 'react';
import { api, session } from '../api';
import { ago, fmtDate, useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, Stat } from '../ui';
import { BASE, usd } from '../crmwf/crmWorkforce';

const post = <T,>(path: string, body: object = {}) => api<T>(`${BASE}/${path}`, { method: 'POST', body: JSON.stringify(body) });
const ROLES = ['STAFF', 'MANAGER', 'ADMIN'] as const;
const RANK: Record<string, number> = { STAFF: 1, MANAGER: 2, ADMIN: 3, SUPER_ADMIN: 4 };

export type Dealership = { tenantId: string; name: string; slug: string; locations: Array<{ id: string; name: string }> };
export type MyDealerships = { homeTenantId: string; groupRole: 'GROUP_ADMIN' | 'GROUP_VIEWER' | null; dealerships: Dealership[] };

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

/**
 * Picks which dealership the CRM Workforce screens act on. Only dealerships the server lists
 * (own, plus the group's for a group member) appear; the server re-checks every request.
 */
export function DealershipSwitcher({ mine, value, onChange }: { mine: MyDealerships; value: string; onChange: (tenantId: string) => void }) {
  if (mine.dealerships.length < 2) return null;
  return (
    <label className="row">
      <span className="small">Dealership</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Dealership">
        {mine.dealerships.map((d) => (
          <option key={d.tenantId} value={d.tenantId}>{d.name}{d.tenantId === mine.homeTenantId ? ' (home)' : ''}</option>
        ))}
      </select>
      {mine.groupRole === 'GROUP_VIEWER' && <Badge tone="info">read only outside your dealership</Badge>}
    </label>
  );
}

type StaffRow = { id: string; email: string; firstName: string; lastName: string; role: string; isActive: boolean; mfaEnabled: boolean; locationId: string | null; location: string | null; createdAt: string; pending: { purpose: 'INVITE' | 'RESET'; expiresAt: string } | null };
type Loc = { id: string; name: string };

/** Team: invitations, password resets, deactivation and role changes for one dealership. */
export function TeamTab({ isAdmin, actingRole, locations, crossDealership = false }: { isAdmin: boolean; actingRole: string; locations: Loc[]; crossDealership?: boolean }) {
  const list = useAsync(() => api<StaffRow[]>(`${BASE}/admin/staff`), []);
  const a = useAct(() => void list.reload());
  const [link, setLink] = useState<{ who: string; url: string; expiresAt: string } | null>(null);
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', role: 'STAFF', locationId: locations.length === 1 ? locations[0].id : '', reason: '' });
  const me = session.user?.id;
  // In another group dealership, administrators are managed only by that dealership.
  const grantable = ROLES.filter((r) => RANK[r] <= (RANK[actingRole] ?? 0) && !(crossDealership && r === 'ADMIN'));
  const show = (who: string, r: { link: string; expiresAt: string }) => setLink({ who, url: `${window.location.origin}${r.link}`, expiresAt: r.expiresAt });

  return (
    <>
      {link && (
        <Card title={`One-time link for ${link.who}`}>
          <p className="small">Give this link to the person yourself (in person, by phone or from your own email). It is shown <strong>only now</strong>, works once and expires {fmtDate(link.expiresAt)}. They choose their own password; nobody else sees it.</p>
          <div className="row">
            <input readOnly value={link.url} aria-label="One-time link" onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} />
            <button className="btn" onClick={() => void navigator.clipboard?.writeText(link.url)}>Copy</button>
            <button className="btn btn--ghost" onClick={() => setLink(null)}>Done</button>
          </div>
        </Card>
      )}
      {a.note}
      {isAdmin && (
        <Card title="Invite a person">
          <p className="muted small">The account stays switched off until the person opens the link and sets a password. Granting Admin needs a written reason, which is kept in the audit ledger. You cannot grant a role above your own.{crossDealership && ' In another group dealership you manage staff and managers only; its administrators are managed there.'}</p>
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              const body = { ...form, email: form.email.trim(), locationId: form.locationId || undefined, reason: form.reason.trim() || undefined };
              void a.act(async () => {
                const r = await post<{ link: string; expiresAt: string }>('admin/staff/invite', body);
                show(`${form.firstName} ${form.lastName}`, r);
                setForm({ ...form, email: '', firstName: '', lastName: '', reason: '' });
              }, 'Invitation created.');
            }}
          >
            <input required placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} aria-label="First name" />
            <input required placeholder="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} aria-label="Last name" />
            <input required type="email" placeholder="Work email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-label="Work email" />
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} aria-label="Role">
              {grantable.map((r) => <option key={r} value={r}>{r[0] + r.slice(1).toLowerCase()}</option>)}
            </select>
            <select value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })} aria-label="Store" required={form.role !== 'ADMIN'}>
              <option value="">{form.role === 'ADMIN' ? 'All stores' : 'Choose store'}</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {form.role === 'ADMIN' && <input required minLength={10} placeholder="Why this person needs Admin" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} aria-label="Reason for Admin" style={{ minWidth: 260 }} />}
            <button className="btn btn--primary" disabled={a.busy}>Create invitation</button>
          </form>
        </Card>
      )}
      <Card title="People at this dealership">
        <ErrorNote error={list.error} />
        {!list.data ? <p aria-busy="true">Loading…</p> : !list.data.length ? <Empty>No accounts.</Empty> : (
          <table className="table">
            <thead><tr><th>Person</th><th>Role</th><th>Store</th><th>Status</th><th>Sign-in security</th>{isAdmin && <th>Actions</th>}</tr></thead>
            <tbody>{list.data.map((p) => {
              const self = p.id === me;
              const higher = (RANK[p.role] ?? 0) > (RANK[actingRole] ?? 0) || (crossDealership && (RANK[p.role] ?? 0) >= RANK.ADMIN);
              const can = isAdmin && !self && !higher;
              return (
                <tr key={p.id}>
                  <td><strong>{p.firstName} {p.lastName}</strong>{self && <> <Badge>you</Badge></>}<div className="muted small">{p.email}</div></td>
                  <td>
                    {can ? (
                      <select
                        value={p.role}
                        aria-label={`Role for ${p.firstName}`}
                        disabled={a.busy}
                        onChange={(e) => {
                          const role = e.target.value;
                          const reason = role === 'ADMIN' ? window.prompt('Why does this person need Admin? (kept in the audit ledger)') ?? '' : undefined;
                          if (role === 'ADMIN' && (reason ?? '').trim().length < 10) return;
                          void a.act(() => post(`admin/staff/${p.id}/role`, { role, locationId: role === 'ADMIN' ? undefined : p.locationId ?? undefined, reason }), 'Role updated.');
                        }}
                      >
                        {grantable.map((r) => <option key={r} value={r}>{r[0] + r.slice(1).toLowerCase()}</option>)}
                      </select>
                    ) : p.role[0] + p.role.slice(1).toLowerCase().replace('_', ' ')}
                  </td>
                  <td>{p.location ?? <span className="muted">all stores</span>}</td>
                  <td>
                    {p.isActive ? <Badge tone="ok">active</Badge> : p.pending?.purpose === 'INVITE' ? <Badge tone="info">invited</Badge> : p.pending?.purpose === 'RESET' ? <Badge tone="warn">reset pending</Badge> : <Badge tone="neutral">deactivated</Badge>}
                    {p.pending && <div className="muted small">link expires {ago(p.pending.expiresAt).replace(' ago', '')}</div>}
                  </td>
                  <td>{p.mfaEnabled ? <Badge tone="ok">authenticator on</Badge> : ['ADMIN', 'SUPER_ADMIN', 'MANAGER'].includes(p.role) ? <Badge tone="warn">authenticator not set up</Badge> : <span className="muted">password</span>}</td>
                  {isAdmin && (
                    <td className="row">
                      {can && <button className="btn btn--ghost" disabled={a.busy} onClick={() => { if (window.confirm(`Reset ${p.firstName}'s password? They are signed out everywhere and need the new link to get back in.`)) void a.act(async () => show(`${p.firstName} ${p.lastName}`, await post<{ link: string; expiresAt: string }>(`admin/staff/${p.id}/reset`)), 'Password reset; they are signed out.'); }}>{p.isActive ? 'Reset password' : 'New link'}</button>}
                      {can && p.isActive && <button className="btn btn--ghost" disabled={a.busy} onClick={() => { if (window.confirm(`Deactivate ${p.firstName}? They are signed out at once.`)) void a.act(() => post(`admin/staff/${p.id}/deactivate`), 'Deactivated.'); }}>Deactivate</button>}
                      {can && <button className="btn btn--ghost" disabled={a.busy} onClick={() => { const reason = window.prompt(`Offboard ${p.firstName}? This ends every session, removes group access, resets their authenticator, returns their open items to the queue and retires their directory entries. Reason (kept in the audit ledger):`) ?? ''; if (reason.trim().length >= 5) void a.act(() => post(`admin/staff/${p.id}/offboard`, { reason }), 'Offboarded.'); }}>Offboard</button>}
                      {can && !p.isActive && !p.pending && <button className="btn btn--ghost" disabled={a.busy} onClick={() => void a.act(() => post(`admin/staff/${p.id}/reactivate`), 'Reactivated.')}>Reactivate</button>}
                      {self && <span className="muted small">change your own account under Security</span>}
                    </td>
                  )}
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </Card>
    </>
  );
}

type CostLimits = { dailyDraftLimit: number; dailyBudgetMicroUsd: number; dealershipSetting: { dailyDraftLimit?: number; dailyBudgetMicroUsd?: number } | null; platform: { dailyDraftLimit: number; dailyBudgetMicroUsd: number } };

/** Model-use limits for this dealership. They can only be tightened below the platform limit. */
export function CostLimitsCard({ isAdmin }: { isAdmin: boolean }) {
  const c = useAsync(() => api<CostLimits>(`${BASE}/admin/cost-limits`), []);
  const a = useAct(() => void c.reload());
  const [drafts, setDrafts] = useState('');
  const [dollars, setDollars] = useState('');
  const d = c.data;
  return (
    <Card title="Model cost limits">
      <p className="muted small">Each rooftop stops asking the AI model for drafts when either daily limit is reached; staff then write replies themselves. A dealership can set a lower limit than the platform, never a higher one.</p>
      <ErrorNote error={c.error} />
      {a.note}
      {d && (
        <div className="row wrap">
          <Stat label="Drafts per rooftop per day" value={d.dailyDraftLimit} hint={`platform limit ${d.platform.dailyDraftLimit}`} />
          <Stat label="Model spend per rooftop per day" value={!d.dailyBudgetMicroUsd ? 'no dollar limit' : usd(d.dailyBudgetMicroUsd)} hint={!d.platform.dailyBudgetMicroUsd ? 'platform: no dollar limit' : `platform limit ${usd(d.platform.dailyBudgetMicroUsd)}`} />
        </div>
      )}
      {isAdmin && d && (
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            const body: Record<string, number> = {};
            if (drafts) body.dailyDraftLimit = Number(drafts);
            if (dollars) body.dailyBudgetMicroUsd = Math.round(Number(dollars) * 1_000_000);
            void a.act(() => post('admin/cost-limits', body), 'Limits saved.');
            setDrafts('');
            setDollars('');
          }}
        >
          <input type="number" min={0} max={d.platform.dailyDraftLimit} placeholder="Drafts per day" value={drafts} onChange={(e) => setDrafts(e.target.value)} aria-label="Drafts per day" />
          <input type="number" min={0} step="0.01" placeholder="Dollars per day" value={dollars} onChange={(e) => setDollars(e.target.value)} aria-label="Dollars per day" />
          <button className="btn" disabled={a.busy || (!drafts && !dollars)}>Save limits</button>
        </form>
      )}
    </Card>
  );
}

/** Stops or resumes every dealership in the group at once. Group administrators only. */
export function GroupStopCard({ mine }: { mine: MyDealerships }) {
  const a = useAct(() => undefined);
  const [reason, setReason] = useState('');
  if (mine.groupRole !== 'GROUP_ADMIN') return null;
  const go = (halted: boolean) => {
    const what = halted ? `Stop CRM Workforce at all ${mine.dealerships.length} dealerships now?` : `Resume all ${mine.dealerships.length} dealerships? Each returns to the mode it had before.`;
    if (!window.confirm(what)) return;
    void a.act(() => post('admin/group-stop', { halted, reason: reason.trim() || (halted ? 'Group stop from Command Center' : 'Group resume from Command Center') }), halted ? 'Every dealership in the group is stopped.' : 'Every dealership in the group is resumed.');
    setReason('');
  };
  return (
    <Card title="Group emergency stop">
      <p className="muted small">Stops drafting and every automated step at {mine.dealerships.map((d) => d.name).join(', ')}. It does not touch the website concierge. Resuming restores each dealership’s previous mode.</p>
      {a.note}
      <div className="row wrap">
        <input placeholder="Reason (kept in the audit ledger)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" style={{ minWidth: 280 }} />
        <button className="btn btn--danger" disabled={a.busy} onClick={() => go(true)}>Stop all dealerships</button>
        <button className="btn btn--ghost" disabled={a.busy} onClick={() => go(false)}>Resume all</button>
      </div>
    </Card>
  );
}

type Policy = { version: string; contactWindow: { startMin: number; endMin: number }; maxPerDay: Record<string, number>; maxPerWeek: Record<string, number>; maxUnansweredAttempts: number; marketingConsentMaxAgeDays: number; restrictedLeadSources: string[]; legalApproval: { approvedBy: string; approvedAt: string; documentRef: string } | null };
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The communication policy in force. Read-only here: only the platform operator records a
 *  counsel-approved policy, and no system message can be sent without one. */
export function PolicyCard() {
  const p = useAsync(() => api<Policy>(`${BASE}/policy`), []);
  const x = p.data;
  return (
    <Card title="Communication policy">
      <ErrorNote error={p.error} />
      {x && (
        <>
          <p>
            Version <code>{x.version}</code>{' '}
            {x.legalApproval ? <Badge tone="ok">approved by counsel · {x.legalApproval.approvedBy} · {fmtDate(x.legalApproval.approvedAt)} · {x.legalApproval.documentRef}</Badge> : <Badge tone="warn">not approved by counsel — system sending stays blocked</Badge>}
          </p>
          <table className="table">
            <tbody>
              <tr><th>Contact hours (customer’s time zone)</th><td>{hhmm(x.contactWindow.startMin)}–{hhmm(x.contactWindow.endMin)}</td></tr>
              {Object.keys(x.maxPerDay).map((k) => <tr key={k}><th>{k[0] + k.slice(1).toLowerCase()} messages</th><td>{x.maxPerDay[k]} per day · {x.maxPerWeek[k]} per week</td></tr>)}
              <tr><th>Unanswered attempts before stopping</th><td>{x.maxUnansweredAttempts}</td></tr>
              <tr><th>Marketing consent valid for</th><td>{x.marketingConsentMaxAgeDays} days</td></tr>
              <tr><th>Lead sources excluded from automation</th><td>{x.restrictedLeadSources.length ? x.restrictedLeadSources.join(', ') : 'none'}</td></tr>
            </tbody>
          </table>
          <p className="muted small">To change it, send the counsel-approved wording and limits to the platform operator; the change is recorded with the approving document.</p>
        </>
      )}
    </Card>
  );
}

type AccessRow = { id: string; action: string; at: string; who: string | null; email: string | null; subject: string | null; subjectEmail: string | null; ip: string | null; reason: string | null };
const ACCESS_LABEL: Record<string, string> = {
  'auth.login': 'Signed in', 'auth.login.failed': 'Failed sign-in', 'auth.login.password_ok_mfa_pending': 'Password accepted, waiting for authenticator', 'auth.mfa.failed': 'Wrong authenticator code', 'auth.mfa.recovery_code_used': 'Recovery code used', 'auth.logout_all': 'Signed out everywhere', 'auth.mfa.reset': 'Authenticator reset',
  'crmwf.staff.invited': 'Invited', 'crmwf.staff.invite_accepted': 'Invitation accepted', 'crmwf.staff.password_set': 'Password reset completed', 'crmwf.staff.reset': 'Password reset issued', 'crmwf.staff.deactivated': 'Deactivated', 'crmwf.staff.reactivated': 'Reactivated', 'crmwf.staff.role_changed': 'Role changed', 'crmwf.staff.offboarded': 'Offboarded', 'crmwf.group_membership.granted': 'Group access granted',
};

/** Who signed in, who failed to, and every account change — last 30 days. Administrators. */
export function AccessLogCard() {
  const r = useAsync(() => api<AccessRow[]>(`${BASE}/admin/access-log?days=30`), []);
  const failed = (r.data ?? []).filter((x) => x.action === 'auth.login.failed' || x.action === 'auth.mfa.failed').length;
  return (
    <Card title="Staff access log (30 days)">
      <p className="muted small">Sign-ins, failed sign-ins and account changes at this dealership. Passwords and authenticator codes are never recorded. {failed ? `${failed} failed attempt(s).` : ''}</p>
      <ErrorNote error={r.error} />
      {!r.data ? <p aria-busy="true">Loading…</p> : !r.data.length ? <Empty>No access events recorded.</Empty> : (
        <table className="table">
          <thead><tr><th>When</th><th>Event</th><th>Person</th><th>Detail</th></tr></thead>
          <tbody>{r.data.slice(0, 100).map((x) => (
            <tr key={x.id}><td className="small">{fmtDate(x.at)}</td><td><Badge tone={/failed|reset|offboard|deactivat/.test(x.action) ? 'warn' : 'neutral'}>{ACCESS_LABEL[x.action] ?? x.action}</Badge></td><td className="small">{x.subject && x.subject !== x.who ? <>{x.subject}<div className="muted">by {x.who ?? 'the person'}</div></> : <>{x.who ?? '—'}<div className="muted">{x.email ?? ''}</div></>}</td><td className="small muted">{[x.reason?.replace(/_/g, ' '), x.ip].filter(Boolean).join(' · ')}</td></tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

type DeliveryStatus = { enabled: boolean; reason?: string; channel?: string; recipients?: number; schedule: Array<{ kind: string; weekday: number | null; minute: number }> };
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Scheduled report delivery: state and an exact preview. Delivery is off until approval R14. */
export function ReportDeliveryCard({ locationId }: { locationId: string }) {
  const st = useAsync(() => api<DeliveryStatus>(`${BASE}/report-delivery`), []);
  const [kind, setKind] = useState('morning');
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Scheduled reports">
      <ErrorNote error={st.error ?? err} />
      {st.data && (
        <p>
          {st.data.enabled ? <Badge tone="ok">delivering by {st.data.channel} to {st.data.recipients} destination(s)</Badge> : <Badge tone="neutral">not delivering — {st.data.reason}</Badge>}
          <span className="muted small"> Schedule (Chicago time): {st.data.schedule.map((s) => `${s.kind.replace('_', ' ')} ${s.weekday !== null ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.weekday] + ' ' : ''}${hm(s.minute)}`).join(' · ')}</span>
        </p>
      )}
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Report">
          <option value="morning">Morning</option><option value="midday">Midday</option><option value="end_of_day">End of day</option><option value="weekly">Weekly</option>
        </select>
        <button className="btn btn--ghost" disabled={!locationId} onClick={async () => { setErr(null); try { setText((await api<{ text: string }>(`${BASE}/report-delivery/preview?kind=${kind}&locationId=${encodeURIComponent(locationId)}`)).text); } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); } }}>Preview what would be sent</button>
      </div>
      {text && <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{text}</pre>}
    </Card>
  );
}
