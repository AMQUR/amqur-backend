import { api } from '../api';
import { ago, useAsync } from '../hooks';
import { EscalationActions } from '../EscalationActions';
import { PartsActions, type OpsQueuesPayload } from './opsQueueShared';
import { Badge, Card, Empty, ErrorNote, Stat, statusTone } from '../ui';

type OverviewAttention = {
  attention: { partsOpen: number };
};

function locQuery(locationId: string) {
  return locationId ? `?locationId=${encodeURIComponent(locationId)}` : '';
}

export function Parts({ locationId }: { locationId: string }) {
  const locQ = locQuery(locationId);
  const queues = useAsync(
    () => api<OpsQueuesPayload>(`/ops/queues${locQ}`),
    [locationId],
  );
  const overview = useAsync(
    () => api<OverviewAttention>(`/ops/overview${locQ}`),
    [locationId],
  );

  const data = queues.data;
  const parts = data?.parts ?? [];
  const partsHandoffs = (data?.escalations ?? []).filter(
    (e) => e.reason === 'PARTS_ADVISOR' && e.status === 'OPEN',
  );
  const needsVin = parts.filter((p) => !p.vin && !p.partNumber).length;
  const fitmentPending = parts.filter((p) => !p.fitmentVerified).length;
  const quoteUnverified = parts.filter((p) => p.status === 'QUOTED' && !p.priceVerified).length;

  return (
    <div className="page">
      <h1>Parts</h1>
      <p className="muted">
        Open parts inquiries from <code>GET /ops/queues</code>. Fitment and price flags reflect staff verification only — not OEM catalog sync.
      </p>
      <p className="row small">
        <a href="#/queues">All work queues</a>
        <a href="#/inbox">Inbox</a>
      </p>
      <ErrorNote error={queues.error ?? overview.error} />

      {overview.data && (
        <Card title="Platform count">
          <div className="stats">
            <Stat
              label="Parts open (overview)"
              value={overview.data.attention.partsOpen}
              hint="same source as Today · Needs attention"
            />
          </div>
        </Card>
      )}

      {data && parts.length > 0 && (
        <Card title="Queue signals">
          <div className="stats">
            {needsVin > 0 && <Stat label="Needs VIN / part #" value={needsVin} />}
            {fitmentPending > 0 && <Stat label="Fitment unverified" value={fitmentPending} />}
            {quoteUnverified > 0 && <Stat label="Quoted · price unverified" value={quoteUnverified} />}
            {needsVin === 0 && fitmentPending === 0 && quoteUnverified === 0 && (
              <p className="muted small">No blocking verification flags on open inquiries.</p>
            )}
          </div>
        </Card>
      )}

      {data && (
        <div className="grid2">
          <Card title={`Parts advisor handoffs (${partsHandoffs.length})`}>
            {!partsHandoffs.length ? (
              <Empty>No open parts advisor escalations.</Empty>
            ) : (
              <ul className="list">
                {partsHandoffs.map((e) => (
                  <li key={e.id} className="stack">
                    <span className="row">
                      <span>{e.reason}{e.summary ? ` · ${e.summary.slice(0, 120)}` : ''}</span>
                      <Badge tone={e.urgency === 'HIGH' || e.urgency === 'CRITICAL' ? 'bad' : 'neutral'}>{e.urgency}</Badge>
                    </span>
                    <span className="row">
                      <span className="muted small">{e.createdAt ? ago(e.createdAt) : ''}</span>
                      {e.conversationId && (
                        <a className="small" href={`#/inbox?conversation=${e.conversationId}`}>Open inbox</a>
                      )}
                    </span>
                    <EscalationActions escalation={e} onUpdated={() => void queues.reload()} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Parts inquiries (${parts.length})`}>
            {queues.loading && !data ? <p className="muted">Loading…</p> : null}
            {!parts.length ? (
              <Empty>No open parts inquiries.</Empty>
            ) : (
              <ul className="list">
                {parts.map((p) => {
                  const openPartsAdvisor = partsHandoffs.some(
                    (e) => e.conversationId === p.conversationId,
                  );
                  return (
                    <li key={p.id} className="stack">
                      <span className="row">
                        <span>
                          {p.suspectedPart ?? p.partNumber ?? 'Parts request'} · {[p.vehicleYear, p.vehicleModel].filter(Boolean).join(' ')}
                          {p.customerName ? ` · ${p.customerName}` : ''}
                        </span>
                        <Badge tone={statusTone(p.status)}>{p.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                      </span>
                      <span className="row">
                        {!p.vin && !p.partNumber && <Badge tone="warn">needs VIN</Badge>}
                        {!p.fitmentVerified && <Badge tone="warn">fitment unverified</Badge>}
                        {p.status === 'QUOTED' && !p.priceVerified && <Badge tone="warn">quote not verified</Badge>}
                        {p.priceVerified && <Badge tone="ok">price verified</Badge>}
                        {p.availabilityVerified && <Badge tone="ok">stock verified</Badge>}
                        {p.installationRequested && <Badge tone="info">install</Badge>}
                        {openPartsAdvisor && <Badge tone="warn">advisor handoff</Badge>}
                        <span className="muted small">{ago(p.createdAt)}</span>
                        {p.conversationId && (
                          <a className="small" href={`#/inbox?conversation=${p.conversationId}`}>Open inbox</a>
                        )}
                      </span>
                      <PartsActions
                        partsId={p.id}
                        conversationId={p.conversationId}
                        status={p.status}
                        notes={p.notes}
                        locationId={locationId || p.locationId || ''}
                        openPartsAdvisor={openPartsAdvisor}
                        onUpdated={() => void queues.reload()}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      )}

      {!queues.loading && !data && !queues.error && (
        <Card title="Parts inquiries">
          <Empty>Queue data unavailable.</Empty>
        </Card>
      )}
    </div>
  );
}
