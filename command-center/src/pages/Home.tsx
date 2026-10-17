import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Badge, Card, ErrorNote, Stat } from '../ui';

type Overview = {
  engagement: { conversations: number; conversationStarts: number; messages: number };
  outcomes: {
    leadsCaptured: number;
    appointmentRequests: number;
    serviceRequests: number;
    confirmedAppointments: number;
    appointmentsCompleted?: number;
    appointmentsNoShow?: number;
    creditLinksOffered: number;
    creditLinksClicked: number;
    note: string;
  };
  attention: { hotLeads: number; appointmentsAwaitingConfirmation: number; openHandoffs: number; partsOpen: number; financeOpen: number; tradesOpen?: number; sourceConflicts: number };
  lifecycle?: {
    note: string;
    stages: Array<{ key: string; label: string; count: number; href: string }>;
    sold: { convertedLeads: number; dealSoldRecorded: number };
    surveys: { available: boolean };
  };
  technical: { outbox: Record<string, number>; inventory: { freshness: Record<string, number>; recentImports: Array<{ id: string; status: string; startedAt: string; records: number | null; rejected: number | null }> }; llm: Array<{ provider: string; configured: boolean; circuitOpen: boolean }> };
  aiQuality: {
    inventoryMisses: number;
    knowledgeMisses: number;
    replyFeedback?: {
      total: number;
      good: number;
      tooLong: number;
      robotic: number;
      wrongFacts: number;
      wrongQuestion: number;
      neededHuman: number;
      unnecessaryRapport: number;
      goodRate: number | null;
    };
  };
};

type Brief = {
  headlines: string[];
  priorities: Array<{ key: string; count: number; href: string }>;
  today: { appointmentsOnBook: number };
  note: string;
};

type Missed = {
  totals: { prioritizedQueueItems: number; analyticsMissEvents: number; combinedAttention: number };
  prioritized: Record<string, number>;
  aiMissSignals: Record<string, number>;
  note: string;
};

/** Deep links for persisted queue + analytics miss counts (no synthetic routing). */
const MISSED_OP_HREF: Record<string, string> = {
  unansweredInbound: '#/inbox',
  aiUncertainReplies: '#/queues',
  overdueLeads: '#/queues',
  missedAppointments: '#/queues',
  partsOpen: '#/parts',
  financeOpen: '#/finance',
  zeroInventoryResults: '#/inventory',
  knowledgeMiss: '#/knowledge',
};

function missedOpRows(missed: Missed): Array<{ key: string; count: number; href: string }> {
  const rows: Array<{ key: string; count: number; href: string }> = [];
  for (const [key, count] of Object.entries(missed.prioritized)) {
    if (count > 0 && MISSED_OP_HREF[key]) rows.push({ key, count, href: MISSED_OP_HREF[key] });
  }
  for (const [key, count] of Object.entries(missed.aiMissSignals)) {
    if (key === 'unansweredInbound') continue;
    if (count > 0 && MISSED_OP_HREF[key]) rows.push({ key, count, href: MISSED_OP_HREF[key] });
  }
  return rows;
}

type Satisfaction = {
  available: boolean;
  reason?: string;
  source?: string;
  csat?: { average: number; count: number; scale: string };
  byKind?: Record<string, { average: number; count: number }>;
  signals?: {
    replyFeedback?: { total: number; good: number; goodRate: number | null; neededHuman: number };
    handoffs?: { openEscalations: number; handoffRequested7d: number };
  };
  note?: string;
  draftsOpen?: number;
};

type ExecutiveExplain = {
  answer: string;
  metrics: Record<string, number | string | Record<string, number>>;
  links: string[];
  source: 'platform_records';
  note: string;
};

function ExecutiveExplainCard({ locationId }: { locationId: string }) {
  const [question, setQuestion] = useState('');
  const [explain, setExplain] = useState<ExecutiveExplain | null>(null);
  const [loading, setLoading] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);

  const ask = async () => {
    const trimmed = question.trim();
    if (!trimmed) return;
    const p = new URLSearchParams();
    if (locationId) p.set('locationId', locationId);
    p.set('q', trimmed);
    setLoading(true);
    setExplainError(null);
    try {
      setExplain(await api<ExecutiveExplain>(`/ops/executive/explain?${p}`));
    } catch (e) {
      setExplain(null);
      setExplainError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Executive explain">
      <p className="muted small">
        Ask about leads, appointments, handoffs, parts, finance, trades, CSI, inventory, or knowledge —
        answers use verified platform counts only.
      </p>
      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="search"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask();
          }}
          placeholder="e.g. How are leads this week?"
          aria-label="Executive question"
          style={{ flex: '1 1 16rem', minWidth: '12rem' }}
        />
        <button type="button" disabled={loading || !question.trim()} onClick={() => void ask()}>
          {loading ? '…' : 'Explain'}
        </button>
      </div>
      {explainError && <p className="muted small">{explainError}</p>}
      {explain && (
        <>
          <p>{explain.answer}</p>
          {explain.links.length > 0 && (
            <p className="small">
              {explain.links.map((href) => (
                <a key={href} href={href} style={{ marginRight: '0.75rem' }}>
                  {href.replace('#/', '')}
                </a>
              ))}
            </p>
          )}
          <p className="muted small">{explain.note}</p>
        </>
      )}
    </Card>
  );
}

export function Home({ locationId }: { locationId: string }) {
  const q = locationId ? `?locationId=${locationId}` : '';
  const { data, error } = useAsync(() => api<Overview>(`/ops/overview${q}`), [q]);
  const brief = useAsync(() => api<Brief>(`/ops/daily-brief${q}`), [q]);
  const missed = useAsync(() => api<Missed>(`/ops/missed-opportunities${q}`), [q]);
  const sat = useAsync(() => api<Satisfaction>(`/ops/satisfaction${q}`), [q]);
  return (
    <div className="page">
      <h1>Today</h1>
      <ErrorNote error={error ?? brief.error ?? missed.error ?? sat.error} />
      <ExecutiveExplainCard locationId={locationId} />
      {brief.data && (
        <Card title="Manager daily brief">
          <ul className="bullets">
            {brief.data.headlines.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
          {brief.data.priorities.length > 0 && (
            <div className="stats">
              {brief.data.priorities.map((p) => (
                <a key={p.key} href={p.href}>
                  <Stat label={p.key.replace(/_/g, ' ')} value={p.count} />
                </a>
              ))}
            </div>
          )}
          <p className="muted small">{brief.data.note}</p>
        </Card>
      )}
      {missed.data && (() => {
        const missedRows = missedOpRows(missed.data);
        return (
        <Card title="Missed opportunities · 7 days">
          <div className="stats">
            <Stat label="Queue items" value={missed.data.totals.prioritizedQueueItems} />
            <Stat label="AI miss signals" value={missed.data.totals.analyticsMissEvents} />
            <Stat label="Combined attention" value={missed.data.totals.combinedAttention} />
          </div>
          {missedRows.length > 0 && (
            <div className="stats">
              {missedRows.map((row) => (
                <a key={row.key} href={row.href}>
                  <Stat label={row.key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()} value={row.count} />
                </a>
              ))}
            </div>
          )}
          <p className="muted small">{missed.data.note}</p>
        </Card>
        );
      })()}
      {sat.data && (
        <Card title="Customer satisfaction">
          {sat.data.available && sat.data.csat ? (
            <div className="stats">
              <Stat label="CSI average" value={sat.data.csat.average} hint={`${sat.data.csat.count} responses · ${sat.data.csat.scale} · internal only`} />
              {sat.data.byKind &&
                Object.entries(sat.data.byKind).map(([kind, v]) => (
                  <Stat key={kind} label={`${kind} CSI`} value={v.average} hint={`${v.count} responses`} />
                ))}
            </div>
          ) : (
            <p className="muted small">
              {sat.data.reason === 'no_survey_responses' ? (
                <>
                  No CSI responses in the last 7 days —{' '}
                  <a href="#/surveys">open CSI surveys</a>
                  {sat.data.draftsOpen
                    ? ` (${sat.data.draftsOpen} draft${sat.data.draftsOpen === 1 ? '' : 's'} awaiting score).`
                    : ' to record in-person or phone scores (no auto-SMS).'}
                </>
              ) : (
                `Survey scores unavailable (${sat.data.reason ?? 'unknown'}). Proxy signals only.`
              )}
            </p>
          )}
          {sat.data.signals?.replyFeedback && (
            <div className="stats">
              <Stat
                label="Staff good replies"
                value={`${sat.data.signals.replyFeedback.good}/${sat.data.signals.replyFeedback.total}`}
              />
              <Stat label="Needed human" value={sat.data.signals.replyFeedback.neededHuman} />
              <Stat label="Open handoffs" value={sat.data.signals.handoffs?.openEscalations ?? 0} />
            </div>
          )}
          {sat.data.note && <p className="muted small">{sat.data.note}</p>}
        </Card>
      )}
      {data && (
        <>
          {data.lifecycle && (
            <Card title="Customer lifecycle">
              <div className="stats">
                {data.lifecycle.stages.map((s) => (
                  <a key={s.key} href={s.href}>
                    <Stat label={s.label} value={s.count} />
                  </a>
                ))}
              </div>
              <p className="muted small">{data.lifecycle.note}</p>
              {!data.lifecycle.surveys.available && (
                <p className="muted small">CSI follow-up counts unavailable until CustomerSurvey is connected.</p>
              )}
            </Card>
          )}
          <Card title="Needs attention">
            <div className="stats">
              <a href="#/inbox"><Stat label="Open handoffs" value={data.attention.openHandoffs} /></a>
              <a href="#/service"><Stat label="Appointments to confirm" value={data.attention.appointmentsAwaitingConfirmation} /></a>
              <a href="#/inbox"><Stat label="Hot leads" value={data.attention.hotLeads} /></a>
              <a href="#/parts"><Stat label="Parts requests" value={data.attention.partsOpen} /></a>
              <a href="#/finance"><Stat label="Finance requests" value={data.attention.financeOpen} /></a>
              <a href="#/queues"><Stat label="Trade-ins" value={data.attention.tradesOpen ?? 0} /></a>
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
                <Stat label="Completed / no-show" value={`${data.outcomes.appointmentsCompleted ?? 0}/${data.outcomes.appointmentsNoShow ?? 0}`} hint="staff-recorded · 7d" />
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
                    {Object.entries(data.technical.outbox).map(([k, v]) => {
                      const badge = (
                        <Badge tone={k === 'DEAD' ? 'bad' : k === 'PENDING' ? 'warn' : 'neutral'}>
                          {k} {v}
                        </Badge>
                      );
                      return k === 'DEAD' && v > 0 ? (
                        <a key={k} href="#/ops">
                          {badge}
                        </a>
                      ) : (
                        <span key={k}>{badge}</span>
                      );
                    })}
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
                <Stat
                  label="Staff: good replies"
                  value={
                    data.aiQuality.replyFeedback
                      ? `${data.aiQuality.replyFeedback.good}/${data.aiQuality.replyFeedback.total}`
                      : '—'
                  }
                  hint={
                    data.aiQuality.replyFeedback?.goodRate != null
                      ? `${Math.round(data.aiQuality.replyFeedback.goodRate * 100)}% good`
                      : 'rate AI replies in Inbox'
                  }
                />
                <Stat label="Too long" value={data.aiQuality.replyFeedback?.tooLong ?? 0} />
                <Stat label="Wrong facts" value={data.aiQuality.replyFeedback?.wrongFacts ?? 0} />
                <Stat label="Needed human" value={data.aiQuality.replyFeedback?.neededHuman ?? 0} />
              </div>
              <p className="muted small">
                Feedback never auto-publishes playbooks. Review in Conversation Studio before changing tone.
              </p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
