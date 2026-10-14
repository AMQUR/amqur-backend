import { api } from '../api';
import { useAsync } from '../hooks';
import { Badge, Card, ErrorNote, Stat } from '../ui';

type Overview = {
  engagement: { conversations: number; conversationStarts: number; messages: number };
  outcomes: { leadsCaptured: number; appointmentRequests: number; serviceRequests: number; confirmedAppointments: number; creditLinksOffered: number; creditLinksClicked: number; note: string };
  attention: { hotLeads: number; appointmentsAwaitingConfirmation: number; openHandoffs: number; partsOpen: number; financeOpen: number; sourceConflicts: number };
  technical: { outbox: Record<string, number>; inventory: { freshness: Record<string, number>; recentImports: Array<{ id: string; status: string; startedAt: string; records: number | null; rejected: number | null }> }; llm: Array<{ provider: string; configured: boolean; circuitOpen: boolean }> };
  aiQuality: { inventoryMisses: number; knowledgeMisses: number };
};

export function Home({ locationId }: { locationId: string }) {
  const q = locationId ? `?locationId=${locationId}` : '';
  const { data, error } = useAsync(() => api<Overview>(`/ops/overview${q}`), [q]);
  return (
    <div className="page">
      <h1>Today</h1>
      <ErrorNote error={error} />
      {data && (
        <>
          <Card title="Needs attention">
            <div className="stats">
              <a href="#/inbox"><Stat label="Open handoffs" value={data.attention.openHandoffs} /></a>
              <a href="#/appointments"><Stat label="Appointments to confirm" value={data.attention.appointmentsAwaitingConfirmation} /></a>
              <a href="#/inbox"><Stat label="Hot leads" value={data.attention.hotLeads} /></a>
              <a href="#/queues"><Stat label="Parts requests" value={data.attention.partsOpen} /></a>
              <a href="#/queues"><Stat label="Finance requests" value={data.attention.financeOpen} /></a>
              <Stat label="Data conflicts" value={data.attention.sourceConflicts} />
            </div>
          </Card>
          <div className="grid2">
            <Card title="Customer engagement · 7 days">
              <div className="stats">
                <Stat label="Conversations" value={data.engagement.conversations} />
                <Stat label="Messages" value={data.engagement.messages} />
              </div>
            </Card>
            <Card title="Business outcomes · 7 days">
              <div className="stats">
                <Stat label="Leads captured" value={data.outcomes.leadsCaptured} />
                <Stat label="Appointment requests" value={data.outcomes.appointmentRequests + data.outcomes.serviceRequests} />
                <Stat label="Confirmed appointments" value={data.outcomes.confirmedAppointments} />
                <Stat label="Credit app clicks" value={`${data.outcomes.creditLinksClicked}/${data.outcomes.creditLinksOffered}`} hint="clicked / offered" />
              </div>
              <p className="muted small">{data.outcomes.note}</p>
            </Card>
          </div>
          <div className="grid2">
            <Card title="Technical health">
              <ul className="kv">
                <li>
                  <span>Delivery queue</span>
                  <span>
                    {Object.entries(data.technical.outbox).map(([k, v]) => (
                      <Badge key={k} tone={k === 'DEAD' ? 'bad' : k === 'PENDING' ? 'warn' : 'neutral'}>
                        {k} {v}
                      </Badge>
                    ))}
                  </span>
                </li>
                <li>
                  <span>Inventory freshness</span>
                  <span>
                    {Object.entries(data.technical.inventory.freshness).map(([k, v]) => (
                      <Badge key={k} tone={k === 'FRESH' ? 'ok' : 'warn'}>
                        {k} {v}
                      </Badge>
                    ))}
                  </span>
                </li>
                {data.technical.llm.map((l) => (
                  <li key={l.provider}>
                    <span>LLM · {l.provider}</span>
                    <Badge tone={!l.configured ? 'neutral' : l.circuitOpen ? 'bad' : 'ok'}>{!l.configured ? 'not configured' : l.circuitOpen ? 'circuit open' : 'healthy'}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="AI quality signals · 7 days">
              <div className="stats">
                <Stat label="Inventory misses" value={data.aiQuality.inventoryMisses} />
                <Stat label="Knowledge misses" value={data.aiQuality.knowledgeMisses} />
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
