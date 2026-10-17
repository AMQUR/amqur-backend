import { useEffect, useState } from 'react';
import { api, session } from '../api';
import { useAsync } from '../hooks';
import { Badge, Card, ErrorNote } from '../ui';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Day = { open: string; close: string } | null;
type S = {
  id: string; name: string; timezone: string; storeHours: Record<string, Day> | null; holidayHours: Array<{ date: string; closed?: boolean; open?: string; close?: string; note?: string }> | null;
  storeHoursVerifiedAt: string | null; financialPolicy: Record<string, unknown> | null; creditApplication: Record<string, unknown> | null; serviceAmenities: Record<string, unknown> | null;
  messagingPolicy?: { quietStart?: string; quietEnd?: string; maxMarketingPer24h?: number } | null;
  effective: {
    hours: { verified: boolean };
    financialPolicy: { mode: string; illustrativeApr: number; defaultTermMonths: number };
    creditApplication: { available: boolean; reason?: string };
    messaging?: { quietStart: string; quietEnd: string };
  };
};

export function Settings({ locationId }: { locationId: string }) {
  const s = useAsync(() => (locationId ? api<S>(`/ops/locations/${locationId}/settings`) : Promise.resolve(null)), [locationId]);
  const [hours, setHours] = useState<Record<string, Day>>({});
  const [tz, setTz] = useState('');
  const [holidays, setHolidays] = useState('');
  const [policy, setPolicy] = useState({ illustrativeApr: '', defaultTermMonths: '', taxRatePercent: '', docFee: '', verified: false });
  const [amen, setAmen] = useState({ shuttle: '', loaner: '' });
  const [quiet, setQuiet] = useState({ quietStart: '21:00', quietEnd: '08:00' });
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const canEdit = ['SUPER_ADMIN', 'ADMIN'].includes(session.user?.role ?? '');

  useEffect(() => {
    const d = s.data;
    if (!d) return;
    setTz(d.timezone);
    setHours(Object.fromEntries(DAYS.map((k) => [k, d.storeHours?.[k] ?? null])));
    setHolidays((d.holidayHours ?? []).map((h) => `${h.date} ${h.closed ? 'closed' : `${h.open}-${h.close}`}${h.note ? ` ${h.note}` : ''}`).join('\n'));
    const p = d.financialPolicy ?? {};
    setPolicy({ illustrativeApr: String(p.illustrativeApr ?? ''), defaultTermMonths: String(p.defaultTermMonths ?? ''), taxRatePercent: String(p.taxRatePercent ?? ''), docFee: String(p.docFee ?? ''), verified: !!p.verifiedAt });
    const a = d.serviceAmenities ?? {};
    setAmen({ shuttle: a.shuttle === true ? 'yes' : a.shuttle === false ? 'no' : '', loaner: a.loaner === true ? 'yes' : a.loaner === false ? 'no' : '' });
    setQuiet({
      quietStart: d.effective?.messaging?.quietStart ?? d.messagingPolicy?.quietStart ?? '21:00',
      quietEnd: d.effective?.messaging?.quietEnd ?? d.messagingPolicy?.quietEnd ?? '08:00',
    });
  }, [s.data]);

  const save = async (label: string, body: Record<string, unknown>) => {
    setErr(null);
    setSaved(null);
    try {
      const r = await api<S>(`/ops/locations/${locationId}/settings`, { method: 'PATCH', body: JSON.stringify(body) });
      s.setData(r);
      setSaved(`${label} saved`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    }
  };

  if (!locationId) return <div className="page"><h1>Settings</h1><p>Select a rooftop.</p></div>;
  const d = s.data;
  return (
    <div className="page">
      <h1>Rooftop settings {d && <span className="muted">· {d.name}</span>}</h1>
      <ErrorNote error={s.error ?? err} />
      {saved && <p className="banner banner--ok" role="status">{saved}</p>}
      {!canEdit && <p className="banner">Read-only — an admin can change these.</p>}
      {d && (
        <>
          <Card title="Hours" actions={<Badge tone={d.effective.hours.verified ? 'ok' : 'warn'}>{d.effective.hours.verified ? 'verified — customer visible' : 'not verified — hidden from customers'}</Badge>}>
            <label>Timezone (IANA)<input value={tz} onChange={(e) => setTz(e.target.value)} disabled={!canEdit} /></label>
            <table className="table hours">
              <tbody>
                {DAYS.map((k) => (
                  <tr key={k}>
                    <th>{k.toUpperCase()}</th>
                    <td><label className="row"><input type="checkbox" checked={!hours[k]} onChange={(e) => setHours({ ...hours, [k]: e.target.checked ? null : { open: '09:00', close: '18:00' } })} disabled={!canEdit} /> Closed</label></td>
                    <td>{hours[k] && <input type="time" value={hours[k]!.open} onChange={(e) => setHours({ ...hours, [k]: { ...hours[k]!, open: e.target.value } })} disabled={!canEdit} aria-label={`${k} open`} />}</td>
                    <td>{hours[k] && <input type="time" value={hours[k]!.close} onChange={(e) => setHours({ ...hours, [k]: { ...hours[k]!, close: e.target.value } })} disabled={!canEdit} aria-label={`${k} close`} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <label>Holidays & closures (one per line: <code>2026-12-25 closed Christmas</code> or <code>2026-12-24 09:00-15:00</code>)
              <textarea rows={4} value={holidays} onChange={(e) => setHolidays(e.target.value)} disabled={!canEdit} />
            </label>
            {canEdit && (
              <div className="row">
                <button className="btn" onClick={() => void save('Hours', {
                  timezone: tz,
                  storeHours: Object.fromEntries(DAYS.map((k) => [k, hours[k]])),
                  holidayHours: holidays.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
                    const [date, spec, ...note] = l.split(/\s+/);
                    if (spec === 'closed') return { date, closed: true, note: note.join(' ') || undefined };
                    const [open, close] = (spec ?? '').split('-');
                    return { date, open, close, note: note.join(' ') || undefined };
                  }),
                })}>Save hours</button>
                <button className="btn btn--primary" onClick={() => void save('Hours verification', { verifyHours: true })}>I verified these hours are correct</button>
              </div>
            )}
          </Card>
          <div className="grid2">
            <Card title="Payment estimate policy" actions={<Badge tone={d.effective.financialPolicy.mode === 'DEALER_CONFIGURED' ? 'ok' : 'neutral'}>{d.effective.financialPolicy.mode === 'DEALER_CONFIGURED' ? 'dealer tax & fees' : 'illustrative (excludes tax & fees)'}</Badge>}>
              <div className="stack">
                <label>Illustrative APR %<input inputMode="decimal" value={policy.illustrativeApr} onChange={(e) => setPolicy({ ...policy, illustrativeApr: e.target.value })} disabled={!canEdit} /></label>
                <label>Default term (months)<input inputMode="numeric" value={policy.defaultTermMonths} onChange={(e) => setPolicy({ ...policy, defaultTermMonths: e.target.value })} disabled={!canEdit} /></label>
                <label>Sales tax %<input inputMode="decimal" value={policy.taxRatePercent} onChange={(e) => setPolicy({ ...policy, taxRatePercent: e.target.value })} disabled={!canEdit} /></label>
                <label>Documentation fee $<input inputMode="decimal" value={policy.docFee} onChange={(e) => setPolicy({ ...policy, docFee: e.target.value })} disabled={!canEdit} /></label>
                <label className="row"><input type="checkbox" checked={policy.verified} onChange={(e) => setPolicy({ ...policy, verified: e.target.checked })} disabled={!canEdit} /> Tax & fee values verified by the dealership</label>
                {canEdit && <button className="btn" onClick={() => void save('Payment policy', { financialPolicy: {
                  ...(policy.illustrativeApr ? { illustrativeApr: Number(policy.illustrativeApr) } : {}),
                  ...(policy.defaultTermMonths ? { defaultTermMonths: Number(policy.defaultTermMonths) } : {}),
                  ...(policy.taxRatePercent ? { taxRatePercent: Number(policy.taxRatePercent), taxBasis: 'price' } : {}),
                  ...(policy.docFee ? { docFee: Number(policy.docFee) } : {}),
                  ...(policy.verified ? { verifiedAt: new Date().toISOString() } : {}),
                } })}>Save policy</button>}
              </div>
            </Card>
            <CreditDestination locationId={locationId} canEdit={canEdit} />
            <AiControls locationId={locationId} />
          </div>
          <Card title="Service amenities (only verified answers are given to customers)">
            <div className="row">
              {(['shuttle', 'loaner'] as const).map((k) => (
                <label key={k}>{k}
                  <select value={amen[k]} onChange={(e) => setAmen({ ...amen, [k]: e.target.value })} disabled={!canEdit}>
                    <option value="">Unknown (AI says it can’t confirm)</option>
                    <option value="yes">Offered</option>
                    <option value="no">Not offered</option>
                  </select>
                </label>
              ))}
              {canEdit && <button className="btn" onClick={() => void save('Amenities', { serviceAmenities: Object.fromEntries(Object.entries(amen).filter(([, v]) => v).map(([k, v]) => [k, v === 'yes'])) })}>Save amenities</button>}
            </div>
          </Card>
          <Card title="SMS quiet hours" actions={<Badge tone="neutral">DST-aware · rooftop timezone</Badge>}>
            <p className="muted small">
              Automated SMS is deferred outside this window. Enforced again at send time. Defaults 21:00–08:00 local.
            </p>
            <div className="row">
              <label>Quiet start<input type="time" value={quiet.quietStart} onChange={(e) => setQuiet({ ...quiet, quietStart: e.target.value })} disabled={!canEdit} /></label>
              <label>Quiet end<input type="time" value={quiet.quietEnd} onChange={(e) => setQuiet({ ...quiet, quietEnd: e.target.value })} disabled={!canEdit} /></label>
              {canEdit && (
                <button
                  className="btn"
                  onClick={() =>
                    void save('Quiet hours', {
                      messagingPolicy: {
                        quietStart: quiet.quietStart,
                        quietEnd: quiet.quietEnd,
                      },
                    })
                  }
                >
                  Save quiet hours
                </button>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

type CreditStatus = {
  enabled: boolean;
  destination: 'vault' | 'plain' | 'none';
  vault: null | { host: string; providerName: string | null; linkType: string; fingerprint: string; configuredAt: string; authorized: boolean; authorization: { approvedAt: string; evidenceRef: string } | null; demoPreview: boolean };
  customerFacing: { available: boolean; preview?: boolean; reason?: string };
};

/**
 * Write-only destination management. The URL (which may carry a vendor token) is never shown
 * back — only host, fingerprint, link type and authorization. Rotating the URL clears the
 * authorization; going live requires the vendor-confirmed link type + written dealer approval.
 */
function CreditDestination({ locationId, canEdit }: { locationId: string; canEdit: boolean }) {
  const st = useAsync(() => api<CreditStatus>(`/ops/locations/${locationId}/credit-application`), [locationId]);
  const [url, setUrl] = useState('');
  const [linkType, setLinkType] = useState('DEALER_REUSABLE');
  const [evidence, setEvidence] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const run = async (path: string, body?: unknown) => {
    setErr(null);
    try {
      st.setData(await api<CreditStatus>(`/ops/locations/${locationId}/credit-application${path}`, { method: path === '/destination' ? 'PUT' : 'POST', body: body ? JSON.stringify(body) : undefined }));
      setUrl('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    }
  };
  const d = st.data;
  const cf = d?.customerFacing;
  return (
    <Card
      title="Secure credit application"
      actions={cf && <Badge tone={cf.available ? (cf.preview ? 'warn' : 'ok') : 'neutral'}>{cf.available ? (cf.preview ? 'demo preview' : 'live') : `off — ${cf.reason?.replace(/_/g, ' ')}`}</Badge>}
    >
      <ErrorNote error={st.error ?? err} />
      {d?.vault ? (
        <dl className="kv">
          <dt>Provider</dt><dd>{d.vault.providerName ?? '—'} · {d.vault.host}</dd>
          <dt>Link type</dt><dd>{d.vault.linkType.replace(/_/g, ' ').toLowerCase()}</dd>
          <dt>Fingerprint</dt><dd><code>{d.vault.fingerprint}</code> (URL stored encrypted)</dd>
          <dt>Authorization</dt><dd>{d.vault.authorization ? `${new Date(d.vault.authorization.approvedAt).toLocaleDateString()} · ${d.vault.authorization.evidenceRef}` : 'not recorded'}</dd>
        </dl>
      ) : <p className="muted small">No secure destination configured.</p>}
      {canEdit && (
        <div className="stack">
          <label>Replace / rotate destination URL (write-only)<input type="password" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></label>
          <button className="btn" disabled={!url} onClick={() => void run('/destination', { url, linkType: 'UNVERIFIED' })}>Save encrypted (needs authorization before going live)</button>
          <label>Vendor-confirmed link type
            <select value={linkType} onChange={(e) => setLinkType(e.target.value)}>
              <option value="DEALER_REUSABLE">Reusable for this rooftop</option>
              <option value="PUBLIC_REUSABLE">Public reusable link</option>
              <option value="PER_CUSTOMER">Per-customer (static link must not be shared)</option>
            </select>
          </label>
          <label>Written approval reference<input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Ticket / email reference" /></label>
          <div className="row">
            <button className="btn" disabled={!d?.vault || evidence.trim().length < 6} onClick={() => void run('/authorize', { linkType, evidenceRef: evidence })}>Record authorization</button>
            <button className="btn btn--ghost" disabled={!d?.vault} onClick={() => void run('/disable')}>Disable</button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Emergency controls — managers can stop the AI for this rooftop instantly (audited). */
function AiControls({ locationId }: { locationId: string }) {
  const [reason, setReason] = useState('');
  const [state, setState] = useState<{ chat: boolean; llmDisabled: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canUse = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(session.user?.role ?? '');
  const send = async (body: { chat?: boolean; llmDisabled?: boolean }) => {
    setErr(null);
    try {
      setState(await api(`/ops/locations/${locationId}/ai-control`, { method: 'POST', body: JSON.stringify({ ...body, reason }) }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    }
  };
  if (!canUse) return null;
  return (
    <Card title="Emergency AI controls" actions={state && <Badge tone={state.chat ? (state.llmDisabled ? 'warn' : 'ok') : 'bad'}>{state.chat ? (state.llmDisabled ? 'deterministic only' : 'on') : 'AI OFF'}</Badge>}>
      <ErrorNote error={err} />
      <p className="muted small">Takes effect on the next customer message. Every change is audited with your reason.</p>
      <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong answer reported, incident #" /></label>
      <div className="row">
        <button className="btn btn--danger" disabled={reason.trim().length < 3} onClick={() => void send({ chat: false })}>Turn AI off</button>
        <button className="btn" disabled={reason.trim().length < 3} onClick={() => void send({ chat: true, llmDisabled: true })}>On — no language model</button>
        <button className="btn btn--ghost" disabled={reason.trim().length < 3} onClick={() => void send({ chat: true, llmDisabled: false })}>Fully on</button>
      </div>
    </Card>
  );
}
