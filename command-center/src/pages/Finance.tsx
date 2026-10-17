import { api } from '../api';
import { ago, useAsync } from '../hooks';
import { EscalationActions } from '../EscalationActions';
import { FinanceActions, type OpsQueuesPayload } from './opsQueueShared';
import { Badge, Card, Empty, ErrorNote, Stat, statusTone } from '../ui';

type OverviewAttention = {
  attention: { financeOpen: number };
  outcomes?: { creditLinksOffered: number; creditLinksClicked: number };
};

function locQuery(locationId: string) {
  return locationId ? `?locationId=${encodeURIComponent(locationId)}` : '';
}

export function Finance({ locationId }: { locationId: string }) {
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
  const finance = data?.finance ?? [];
  const financeHandoffs = (data?.escalations ?? []).filter(
    (e) => e.reason === 'FINANCE_ADVISOR' && e.status === 'OPEN',
  );
  const creditPending = finance.filter(
    (f) => f.creditLinkState === 'OFFERED' || f.creditLinkState === 'CLICKED',
  ).length;
  const quotes = data?.quotes ?? [];

  return (
    <div className="page">
      <h1>Finance</h1>
      <p className="muted">
        Open finance requests from <code>GET /ops/queues</code>. Credit link state reflects platform events only — not lender decisions.
      </p>
      <p className="row small">
        <a href="#/queues">All work queues</a>
        <a href="#/inbox">Inbox</a>
        <a href="#/settings">Rooftop settings</a>
        <a href="#/sold-deals">Sold deals</a>
      </p>
      <ErrorNote error={queues.error ?? overview.error} />

      {overview.data && (
        <Card title="Platform count">
          <div className="stats">
            <Stat
              label="Finance open (overview)"
              value={overview.data.attention.financeOpen}
              hint="same source as Today · Needs attention"
            />
            {overview.data.outcomes && (
              <Stat
                label="Credit clicks · 7d"
                value={`${overview.data.outcomes.creditLinksClicked}/${overview.data.outcomes.creditLinksOffered}`}
                hint="clicked / offered"
              />
            )}
          </div>
        </Card>
      )}

      {data && finance.length > 0 && (
        <Card title="Queue signals">
          <div className="stats">
            {creditPending > 0 && <Stat label="Credit link in flight" value={creditPending} />}
            {quotes.length > 0 && <Stat label="Open OTD quotes" value={quotes.length} hint="also on All work queues" />}
            {creditPending === 0 && quotes.length === 0 && (
              <p className="muted small">No in-flight credit or open OTD quotes on finance rows.</p>
            )}
          </div>
        </Card>
      )}

      {data && (
        <div className="grid2">
          <Card title={`Finance advisor handoffs (${financeHandoffs.length})`}>
            {!financeHandoffs.length ? (
              <Empty>No open finance advisor escalations.</Empty>
            ) : (
              <ul className="list">
                {financeHandoffs.map((e) => (
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

          <Card title={`Finance requests (${finance.length})`}>
            {queues.loading && !data ? <p className="muted">Loading…</p> : null}
            {!finance.length ? (
              <Empty>No open finance requests.</Empty>
            ) : (
              <ul className="list">
                {finance.map((f) => {
                  const openFinanceAdvisor = financeHandoffs.some(
                    (e) => e.conversationId === f.conversationId,
                  );
                  return (
                    <li key={f.id} className="stack">
                      <span className="row">
                        <span>
                          {f.customerName ?? 'Visitor'} · {f.vehicleVin ?? 'no vehicle'}
                          {f.downPayment != null ? ` · $${f.downPayment.toLocaleString()} down` : ''}
                          {f.desiredPayment != null ? ` · target $${f.desiredPayment}/mo` : ''}
                        </span>
                        <Badge tone={statusTone(f.status)}>{f.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                      </span>
                      <span className="row">
                        <Badge tone={statusTone(f.creditLinkState)}>credit {f.creditLinkState.toLowerCase()}</Badge>
                        {openFinanceAdvisor && <Badge tone="warn">advisor handoff</Badge>}
                        <span className="muted small">{ago(f.createdAt)}</span>
                        {f.conversationId && (
                          <a className="small" href={`#/inbox?conversation=${f.conversationId}`}>Open inbox</a>
                        )}
                      </span>
                      <FinanceActions
                        financeId={f.id}
                        conversationId={f.conversationId}
                        status={f.status}
                        notes={f.notes}
                        locationId={locationId || f.locationId || ''}
                        openFinanceAdvisor={openFinanceAdvisor}
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
        <Card title="Finance requests">
          <Empty>Queue data unavailable.</Empty>
        </Card>
      )}
    </div>
  );
}
