import { api } from '../api';
import { ago, useAsync } from '../hooks';
import { EscalationActions } from '../EscalationActions';
import { AppointmentRequestActions, type OpsQueuesPayload } from './opsQueueShared';
import { Badge, Card, Empty, ErrorNote, Stat, statusTone } from '../ui';

type Outcomes = {
  window: string;
  counts: {
    completed: number;
    noShow: number;
    confirmedOnBook: number;
    awaitingConfirmation: number;
    cancelled: number;
  };
  showRate: number | null;
  note: string;
};

type Satisfaction = {
  available: boolean;
  reason?: string;
  byKind?: Record<string, { average: number; count: number }>;
  note?: string;
  draftsOpen?: number;
};

function locQuery(locationId: string) {
  return locationId ? `?locationId=${encodeURIComponent(locationId)}` : '';
}

export function Service({ locationId }: { locationId: string }) {
  const locQ = locQuery(locationId);
  const queues = useAsync(
    () => api<OpsQueuesPayload>(`/ops/queues${locQ}`),
    [locationId],
  );
  const outcomes = useAsync(() => api<Outcomes>(`/ops/appointment-outcomes${locQ}`), [locationId]);
  const sat = useAsync(() => api<Satisfaction>(`/ops/satisfaction${locQ}`), [locationId]);

  const data = queues.data;
  const serviceAppts = (data?.appointments ?? []).filter((a) => a.type === 'SERVICE');
  const serviceHandoffs = (data?.escalations ?? []).filter(
    (e) => e.reason === 'SERVICE_ADVISOR' && e.status === 'OPEN',
  );
  const missed = (data?.prioritized?.missedAppointments ?? []).filter((a) => a.type === 'SERVICE');
  const serviceCsi = sat.data?.byKind?.SERVICE;

  return (
    <div className="page">
      <h1>Service</h1>
      <p className="muted">
        Actionable service queue from <code>GET /ops/queues</code>, visit outcomes, and internal CSI — no DMS repair-order sync.
      </p>
      <p className="row small">
        <a href="#/appointments">All appointments</a>
        <a href="#/queues">All work queues</a>
        <a href="#/surveys">CSI surveys</a>
      </p>
      <ErrorNote error={queues.error ?? outcomes.error ?? sat.error} />

      {outcomes.data && (
        <Card title="Visit outcomes · 7 days">
          <div className="stats">
            <Stat label="Completed" value={outcomes.data.counts.completed} hint="staff-recorded" />
            <Stat label="No-show" value={outcomes.data.counts.noShow} hint="staff-recorded" />
            <Stat
              label="Show rate"
              value={
                outcomes.data.showRate != null
                  ? `${Math.round(outcomes.data.showRate * 100)}%`
                  : '—'
              }
              hint={
                outcomes.data.showRate != null
                  ? 'completed ÷ (completed + no-show)'
                  : 'mark visits Completed or No-show'
              }
            />
            <Stat label="Awaiting confirm" value={outcomes.data.counts.awaitingConfirmation} />
          </div>
          <p className="muted small">{outcomes.data.note}</p>
        </Card>
      )}

      {sat.data && (
        <Card title="Service CSI · 7 days">
          {serviceCsi && serviceCsi.count > 0 ? (
            <div className="stats">
              <Stat
                label="Service CSI average"
                value={serviceCsi.average}
                hint={`${serviceCsi.count} response${serviceCsi.count === 1 ? '' : 's'} · internal only · not OEM`}
              />
            </div>
          ) : (
            <p className="muted small">
              {sat.data.available
                ? 'No service-kind CSI responses in the last 7 days.'
                : sat.data.reason === 'no_survey_responses'
                  ? (
                    <>
                      No CSI responses in the last 7 days —{' '}
                      <a href="#/surveys">record service CSI</a>
                      {sat.data.draftsOpen
                        ? ` (${sat.data.draftsOpen} draft${sat.data.draftsOpen === 1 ? '' : 's'} open).`
                        : '.'}
                    </>
                  )
                  : `CSI unavailable (${sat.data.reason ?? 'unknown'}).`}
            </p>
          )}
          {sat.data.note && <p className="muted small">{sat.data.note}</p>}
        </Card>
      )}

      {data && (
        <div className="grid2">
          <Card title={`Service advisor handoffs (${serviceHandoffs.length})`}>
            {!serviceHandoffs.length ? (
              <Empty>No open service advisor escalations.</Empty>
            ) : (
              <ul className="list">
                {serviceHandoffs.map((e) => (
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

          <Card title={`Missed service visits (${missed.length})`}>
            {!missed.length ? <Empty>None in the prioritized queue.</Empty> : (
              <ul className="list">
                {missed.map((a) => (
                  <li key={a.id}>
                    <span>{a.type} · {a.requestedDate ?? '—'}</span>
                    <Badge tone="bad">{a.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Service requests in queue (${serviceAppts.length})`}>
            {queues.loading && !data ? <p className="muted">Loading…</p> : null}
            {!serviceAppts.length ? (
              <Empty>No service appointment requests awaiting staff.</Empty>
            ) : (
              <ul className="list">
                {serviceAppts.map((a) => {
                  const openServiceAdvisor = serviceHandoffs.some(
                    (e) => e.conversationId === a.conversationId,
                  );
                  return (
                    <li key={a.id} className="stack">
                      <span className="row">
                        <span>
                          {a.requestedDate ?? '—'} {a.requestedTime ?? ''}
                          {a.customerName ? ` · ${a.customerName}` : ''}
                        </span>
                        <Badge tone={statusTone(a.status)}>{a.status === 'REQUESTED' ? 'request' : a.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                      </span>
                      <span className="row">
                        {!a.availabilityVerified && a.status !== 'CONFIRMED' && <Badge tone="warn">not confirmed</Badge>}
                        {(a.serviceType || a.vehicleVin) && <Badge tone="info">{a.serviceType ?? a.vehicleVin}</Badge>}
                        {a.transportation && <Badge tone="neutral">{a.transportation}</Badge>}
                        {openServiceAdvisor && <Badge tone="warn">advisor handoff</Badge>}
                        <span className="muted small">{ago(a.createdAt)}</span>
                        {a.conversationId && (
                          <a className="small" href={`#/inbox?conversation=${a.conversationId}`}>Open inbox</a>
                        )}
                      </span>
                      <AppointmentRequestActions
                        appointmentId={a.id}
                        conversationId={a.conversationId}
                        status={a.status}
                        notes={a.notes}
                        requestedAt={a.requestedAt}
                        locationId={locationId || a.locationId || ''}
                        openServiceAdvisor={openServiceAdvisor}
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
        <Card title="Service requests">
          <Empty>Queue data unavailable.</Empty>
        </Card>
      )}
    </div>
  );
}
