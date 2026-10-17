import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote } from '../ui';

type GroupSummary = { id: string; name: string };

type StoreRates = {
  leadPerConversation: number | null;
  appointmentConfirmation: number | null;
  handoffDelivery: number | null;
  creditClickThrough: number | null;
  replyFeedbackGoodRate: number | null;
};

type Store = {
  tenant: { id: string; slug: string; name: string };
  counts: Record<string, number>;
  rates: StoreRates;
  inventory: { liveVehicles: number; staleVehicles: number; syntheticFixturesPresent: boolean };
};

type Cmp = { windowDays: number; since: string; stores: Store[]; notes: string[] };

const ROWS: Array<[string, string]> = [
  ['conversations', 'Conversations'],
  ['leads', 'Leads'],
  ['hotLeads', 'Hot leads'],
  ['appointmentRequests', 'Appointment requests'],
  ['appointmentsConfirmed', 'Appointments confirmed'],
  ['handoffs', 'Handoffs'],
  ['handoffsNotified', 'Handoffs delivered to staff'],
  ['otdQuoteRequests', 'OTD quote requests'],
  ['tradeRequests', 'Trade requests'],
  ['tradeOffersIssued', 'Trade offers issued'],
  ['financeRequests', 'Finance requests'],
  ['creditLinksOffered', 'Credit links offered'],
  ['creditLinksClicked', 'Credit links clicked'],
  ['partsInquiries', 'Parts inquiries'],
  ['openHandoffs', 'Open handoffs'],
];

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

const RATE_ROWS: Array<[keyof StoreRates, string]> = [
  ['leadPerConversation', 'Leads per conversation'],
  ['appointmentConfirmation', 'Appointment confirmation rate'],
  ['handoffDelivery', 'Handoff delivery rate'],
  ['creditClickThrough', 'Credit link click-through'],
  ['replyFeedbackGoodRate', 'AI reply feedback (% good)'],
];

/** Group executives: all-store comparison from persisted records only (membership-checked). */
export function Group() {
  const groups = useAsync(() => api<GroupSummary[]>('/dealer-groups'), []);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    if (!groups.data?.length) return;
    setGroupId((prev) => (prev && groups.data!.some((g) => g.id === prev) ? prev : groups.data![0].id));
  }, [groups.data]);

  const gid = groupId ?? groups.data?.[0]?.id;
  const cmp = useAsync(
    () => (gid ? api<Cmp>(`/dealer-groups/${gid}/comparison?days=${days}`) : Promise.resolve(null)),
    [gid, days],
  );

  const loading = groups.loading || (!!gid && cmp.loading);

  return (
    <div className="page">
      <h1>Group comparison</h1>
      <ErrorNote error={groups.error ?? cmp.error} />
      {loading && <p className="muted">Loading…</p>}
      {!loading && !gid && groups.data && <Empty>You are not a member of a dealer group.</Empty>}
      {!loading && gid && groups.data && groups.data.length > 1 && (
        <label className="row">
          <span className="muted small">Dealer group</span>
          <select value={gid} onChange={(e) => setGroupId(e.target.value)}>
            {groups.data.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!loading && cmp.data && cmp.data.stores.length === 0 && (
        <Empty>No rooftops are linked to this dealer group yet.</Empty>
      )}
      {!loading && cmp.data && cmp.data.stores.length > 0 && (
        <>
          <div className="row">
            {[7, 30, 90].map((d) => (
              <button key={d} className={`btn ${d === days ? '' : 'btn--ghost'}`} onClick={() => setDays(d)}>
                Last {d} days
              </button>
            ))}
          </div>
          <Card title={`All stores · since ${new Date(cmp.data.since).toLocaleDateString()}`}>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    {cmp.data.stores.map((s) => (
                      <th scope="col" key={s.tenant.id}>
                        {s.tenant.name}{' '}
                        {s.inventory.syntheticFixturesPresent && <Badge tone="warn">simulated data</Badge>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map(([k, label]) => (
                    <tr key={k}>
                      <th scope="row">{label}</th>
                      {cmp.data!.stores.map((s) => (
                        <td key={s.tenant.id}>{s.counts[k] ?? 0}</td>
                      ))}
                    </tr>
                  ))}
                  {RATE_ROWS.map(([k, label]) => (
                    <tr key={k}>
                      <th scope="row">{label}</th>
                      {cmp.data!.stores.map((s) => (
                        <td key={s.tenant.id}>{pct(s.rates[k] ?? null)}</td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">Live vehicles (stale)</th>
                    {cmp.data.stores.map((s) => (
                      <td key={s.tenant.id}>
                        {s.inventory.liveVehicles} ({s.inventory.staleVehicles})
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            {cmp.data.notes.map((n) => (
              <p key={n} className="muted small">
                {n}
              </p>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
