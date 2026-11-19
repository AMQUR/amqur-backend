import { useState } from 'react';
import { api } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Card, ErrorNote } from '../ui';

type Stage = { stage: string; count: number; evidence: string };
type FunnelData = {
  windowDays: number;
  since: string;
  stages: Stage[];
  notProven: { mailAcceptedSandboxOnly: number; appointmentsSandboxConfirmed: number; appointmentsStaffConfirmedNoReceipt: number };
  needsAttention: { crmRejected: number; blocked: number; failedOrDead: number; acceptedNotConfirmedInCrm: number };
};

const LABEL: Record<string, string> = {
  LEAD_CREATED: 'Lead created',
  LEAD_QUEUED: 'Lead queued for CRM',
  MAIL_ACCEPTED: 'Mail accepted',
  CRM_RECEIVED: 'CRM received',
  CRM_MATCHED: 'CRM matched',
  APPOINTMENT_REQUESTED: 'Appointment requested',
  APPOINTMENT_CONFIRMED: 'Appointment confirmed',
};
const WINDOWS = [7, 30, 90];

/**
 * Lead and appointment funnel for the selected rooftop. Each stage counts only what its own
 * evidence proves; sandbox acknowledgements and staff-only confirmations are listed apart.
 */
export function Funnel({ locationId }: { locationId: string }) {
  const [days, setDays] = useState(7);
  const q = new URLSearchParams({ days: String(days), ...(locationId ? { locationId } : {}) }).toString();
  const funnel = useAsync(() => api<FunnelData>(`/ops/funnel?${q}`), [q]);
  const f = funnel.data;
  const leadStages = f?.stages.filter((s) => !s.stage.startsWith('APPOINTMENT')) ?? [];
  const apptStages = f?.stages.filter((s) => s.stage.startsWith('APPOINTMENT')) ?? [];

  const table = (rows: Stage[], caption: string) => (
    <table className="small">
      <caption className="sr">{caption}</caption>
      <thead><tr><th scope="col">Stage</th><th scope="col">Count</th><th scope="col">What this proves</th></tr></thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.stage}>
            <th scope="row">{LABEL[s.stage] ?? s.stage} <code className="muted">{s.stage}</code></th>
            <td>{s.count}</td>
            <td className="muted">{s.evidence}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="page">
      <h1>Lead and appointment funnel</h1>
      <p className="muted">{locationId ? 'This rooftop only.' : 'All rooftops you can see in this dealership.'} A stage is never counted as a later one: mail accepted is not CRM received.</p>
      <div className="row" role="group" aria-label="Time window">
        {WINDOWS.map((w) => (
          <button key={w} className={w === days ? 'btn' : 'btn btn--ghost'} aria-pressed={w === days} onClick={() => setDays(w)}>
            Last {w} days
          </button>
        ))}
      </div>
      <ErrorNote error={funnel.error} />
      {funnel.loading && !f ? <p aria-busy="true">Loading…</p> : f && (
        <div className="stack">
          <p className="muted small">Since {fmtDate(f.since)}</p>
          <Card title="Leads to CRM">{table(leadStages, 'Lead stages')}</Card>
          <Card title="Appointments">{table(apptStages, 'Appointment stages')}</Card>
          <Card title="Needs attention">
            <dl className="row">
              <div><dt className="muted small">Accepted, not confirmed in CRM</dt><dd>{f.needsAttention.acceptedNotConfirmedInCrm}</dd></div>
              <div><dt className="muted small">CRM rejected</dt><dd>{f.needsAttention.crmRejected}</dd></div>
              <div><dt className="muted small">Blocked, not sent</dt><dd>{f.needsAttention.blocked}</dd></div>
              <div><dt className="muted small">Failed or stopped retrying</dt><dd>{f.needsAttention.failedOrDead}</dd></div>
            </dl>
            <p className="small"><a href="#/lead-deliveries">Open lead deliveries</a></p>
          </Card>
          <Card title="Not counted above">
            <p className="muted small">Test and unproven activity is listed here so it cannot inflate the funnel.</p>
            <dl className="row">
              <div><dt className="muted small">Mail accepted on sandbox routes</dt><dd>{f.notProven.mailAcceptedSandboxOnly}</dd></div>
              <div><dt className="muted small">Confirmed by the demo scheduler</dt><dd>{f.notProven.appointmentsSandboxConfirmed}</dd></div>
              <div><dt className="muted small">Marked confirmed by staff, no provider receipt</dt><dd>{f.notProven.appointmentsStaffConfirmedNoReceipt}</dd></div>
            </dl>
          </Card>
        </div>
      )}
    </div>
  );
}
