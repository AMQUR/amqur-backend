import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Badge, Card, ErrorNote } from '../ui';

type CallQaBlockedReason = 'voice_not_live' | 'insufficient_input';

type CallQaBlocked = {
  status: 'blocked';
  reason: CallQaBlockedReason;
};

type CoachingTip = {
  id: string;
  title: string;
  detail: string;
};

type ListCoachingTipsResult =
  | CallQaBlocked
  | { status: 'ok'; tips: CoachingTip[] };

type SummarizeCallResult =
  | CallQaBlocked
  | { status: 'ok'; externalCallId: string; summary: string };

type ScoreCallResult =
  | CallQaBlocked
  | {
      status: 'ok';
      externalCallId: string;
      score: number;
      dimensions: Record<string, number>;
    };

const QA_BLOCKED: Record<CallQaBlockedReason, string> = {
  voice_not_live:
    'Call QA is not live — voice AI must be enabled with a live-ready voice connection and QA vendor adapter.',
  insufficient_input:
    'Insufficient input — supply a verified transcript or use a call ID with transcript stored on the voice session.',
};

function isQaBlocked(
  r: ListCoachingTipsResult | SummarizeCallResult | ScoreCallResult,
): r is CallQaBlocked {
  return r.status === 'blocked';
}

export function CallQa({ locationId }: { locationId: string }) {
  const [externalCallId, setExternalCallId] = useState('');
  const [transcript, setTranscript] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'summarize' | 'score' | null>(null);
  const [summarizeResult, setSummarizeResult] = useState<SummarizeCallResult | null>(null);
  const [scoreResult, setScoreResult] = useState<ScoreCallResult | null>(null);

  const callId = externalCallId.trim();

  const tips = useAsync(async () => {
    if (!locationId || !callId) return null;
    const q = new URLSearchParams({ locationId, externalCallId: callId });
    return api<ListCoachingTipsResult>(`/ops/call-qa/coaching-tips?${q}`);
  }, [locationId, callId]);

  const tipsBlocked = tips.data && isQaBlocked(tips.data) ? tips.data : null;
  const coachingTips = tips.data && tips.data.status === 'ok' ? tips.data.tips : [];

  const postBody = () => {
    const body: { externalCallId: string; locationId?: string; transcript?: string } = {
      externalCallId: callId,
    };
    if (locationId) body.locationId = locationId;
    const t = transcript.trim();
    if (t) body.transcript = t;
    return body;
  };

  const summarize = async () => {
    if (!locationId || !callId) return;
    setErr(null);
    setSummarizeResult(null);
    setBusy('summarize');
    try {
      const r = await api<SummarizeCallResult>('/ops/call-qa/summarize', {
        method: 'POST',
        body: JSON.stringify(postBody()),
      });
      setSummarizeResult(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Summarize failed');
    } finally {
      setBusy(null);
    }
  };

  const score = async () => {
    if (!locationId || !callId) return;
    setErr(null);
    setScoreResult(null);
    setBusy('score');
    try {
      const r = await api<ScoreCallResult>('/ops/call-qa/score', {
        method: 'POST',
        body: JSON.stringify(postBody()),
      });
      setScoreResult(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Score failed');
    } finally {
      setBusy(null);
    }
  };

  if (!locationId) {
    return (
      <div className="page">
        <h1>Call QA</h1>
        <p>Select a rooftop to load coaching tips and run call QA.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Call QA</h1>
      <p className="muted">
        Summarize, score, and surface coaching tips from verified call transcripts only — never
        synthesized from metadata alone.
      </p>
      <p className="banner banner--warn" role="note">
        Fail-closed: operations return <code>voice_not_live</code> until voice is live-ready and
        the QA provider is configured; summarize/score also require transcript input when none is
        stored on the session.
      </p>
      <ErrorNote error={tips.error ?? err} />
      <Card title="Call context">
        <div className="stack">
          <label>
            External call ID
            <input
              required
              maxLength={128}
              value={externalCallId}
              onChange={(e) => {
                setExternalCallId(e.target.value);
                setSummarizeResult(null);
                setScoreResult(null);
              }}
              placeholder="Provider call / session id"
            />
          </label>
          <label>
            Transcript <span className="muted small">(optional if stored on voice session)</span>
            <textarea
              rows={8}
              maxLength={200_000}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Paste verified transcript for summarize/score when not already on file"
            />
          </label>
          <div className="row">
            <button
              className="btn"
              disabled={!callId || busy !== null}
              onClick={() => void summarize()}
            >
              {busy === 'summarize' ? 'Summarizing…' : 'Summarize call'}
            </button>
            <button
              className="btn btn--primary"
              disabled={!callId || busy !== null}
              onClick={() => void score()}
            >
              {busy === 'score' ? 'Scoring…' : 'Score call'}
            </button>
          </div>
        </div>
      </Card>

      {summarizeResult && (
        <p
          className={`banner ${summarizeResult.status === 'ok' ? 'banner--ok' : ''}`}
          role="status"
        >
          {isQaBlocked(summarizeResult) ? (
            <>Summarize blocked — {QA_BLOCKED[summarizeResult.reason] ?? summarizeResult.reason}</>
          ) : (
            <>
              <strong>Summary</strong> ({summarizeResult.externalCallId}):{' '}
              {summarizeResult.summary}
            </>
          )}
        </p>
      )}

      {scoreResult && (
        <Card title="Score">
          {isQaBlocked(scoreResult) ? (
            <p className="banner" role="status">
              Score blocked — {QA_BLOCKED[scoreResult.reason] ?? scoreResult.reason}
            </p>
          ) : (
            <div className="stack">
              <p>
                Overall <Badge tone="info">{scoreResult.score}</Badge> for{' '}
                <code>{scoreResult.externalCallId}</code>
              </p>
              {Object.keys(scoreResult.dimensions).length > 0 && (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Dimension</th>
                      <th>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(scoreResult.dimensions).map(([k, v]) => (
                      <tr key={k}>
                        <td>{k.replace(/_/g, ' ')}</td>
                        <td>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </Card>
      )}

      <Card
        title="Coaching tips"
        actions={
          tipsBlocked ? (
            <Badge tone="bad">blocked</Badge>
          ) : tips.data?.status === 'ok' ? (
            <Badge tone="info">{coachingTips.length} tips</Badge>
          ) : null
        }
      >
        {!callId && <p className="muted">Enter an external call ID to load tips.</p>}
        {callId && tips.loading && <p className="muted">Loading tips…</p>}
        {callId && tipsBlocked && (
          <p className="banner" role="status">
            Coaching tips unavailable — {QA_BLOCKED[tipsBlocked.reason] ?? tipsBlocked.reason}
          </p>
        )}
        {callId && tips.data?.status === 'ok' && coachingTips.length === 0 && (
          <p className="muted">No coaching tips returned.</p>
        )}
        {coachingTips.length > 0 && (
          <ul className="stack">
            {coachingTips.map((tip) => (
              <li key={tip.id}>
                <strong>{tip.title}</strong>
                <p className="muted">{tip.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
