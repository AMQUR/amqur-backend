import { useState } from 'react';
import { api, session } from '../api';
import { useAsync } from '../hooks';
import { Badge, Card, ErrorNote } from '../ui';

type AiControl = {
  locationId: string;
  name: string;
  policyVersion: string;
  composePromptVersion: string;
  chat: boolean;
  llmDisabled: boolean;
  verboseReplies: boolean;
  contextualRapport: boolean;
  conciseDefault: boolean;
};

export function ConversationStudio({ locationId }: { locationId: string }) {
  const canEdit = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(session.user?.role ?? '');
  const s = useAsync(
    () =>
      locationId
        ? api<AiControl>(`/ops/locations/${locationId}/ai-control`)
        : Promise.resolve(null),
    [locationId],
  );
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = async (body: Partial<AiControl> & { reason: string }) => {
    if (!locationId) return;
    setErr(null);
    setSaved(null);
    setBusy(true);
    try {
      const r = await api<AiControl>(`/ops/locations/${locationId}/ai-control`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      s.setData({ ...r, name: s.data?.name ?? r.locationId, policyVersion: s.data?.policyVersion ?? 'conv-policy-v1-2026-10', composePromptVersion: s.data?.composePromptVersion ?? 'compose-v2-2026-10-short' });
      setSaved('Saved — applies on the next customer message.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  if (!locationId) {
    return (
      <div className="page">
        <h1>Conversation Studio</h1>
        <p>Select a rooftop to manage reply style and AI controls.</p>
      </div>
    );
  }

  const d = s.data;
  return (
    <div className="page">
      <h1>
        Conversation Studio {d && <span className="muted">· {d.name}</span>}
      </h1>
      <p className="muted">
        Customer replies default to one or two natural sentences with at most one follow-up question.
        Dealership facts still come only from verified tools.
      </p>
      <ErrorNote error={s.error ?? err} />
      {saved && (
        <p className="banner banner--ok" role="status">
          {saved}
        </p>
      )}
      {!canEdit && <p className="banner">Read-only — a manager or admin can change these.</p>}
      {d && (
        <>
          <Card
            title="Reply length"
            actions={
              <Badge tone={d.conciseDefault ? 'ok' : 'warn'}>
                {d.conciseDefault ? 'concise (default)' : 'verbose opted-in'}
              </Badge>
            }
          >
            <p className="small">
              Concise mode targets 1–2 sentences. Turn on verbose only if this rooftop still needs longer essays while migrating.
            </p>
            {canEdit && (
              <div className="row">
                <button
                  className="btn btn--primary"
                  disabled={busy || d.conciseDefault}
                  onClick={() =>
                    void patch({
                      verboseReplies: false,
                      reason: 'Conversation Studio: enable concise replies',
                    })
                  }
                >
                  Use concise replies
                </button>
                <button
                  className="btn"
                  disabled={busy || d.verboseReplies}
                  onClick={() =>
                    void patch({
                      verboseReplies: true,
                      reason: 'Conversation Studio: allow longer replies',
                    })
                  }
                >
                  Allow longer replies
                </button>
              </div>
            )}
          </Card>

          <Card
            title="Contextual rapport"
            actions={
              <Badge tone={d.contextualRapport ? 'info' : 'neutral'}>
                {d.contextualRapport ? 'daypart on' : 'off'}
              </Badge>
            }
          >
            <p className="small">
              Optional daypart greetings only. Weather and sports still require verified live data and never override a price or inventory question.
            </p>
            {canEdit && (
              <div className="row">
                <button
                  className="btn"
                  disabled={busy || d.contextualRapport}
                  onClick={() =>
                    void patch({
                      contextualRapport: true,
                      reason: 'Conversation Studio: enable rapport',
                    })
                  }
                >
                  Enable daypart rapport
                </button>
                <button
                  className="btn"
                  disabled={busy || !d.contextualRapport}
                  onClick={() =>
                    void patch({
                      contextualRapport: false,
                      reason: 'Conversation Studio: disable rapport',
                    })
                  }
                >
                  Disable
                </button>
              </div>
            )}
          </Card>

          <Card title="Kill switches">
            <div className="stack">
              <p className="small">
                Chat: <Badge tone={d.chat ? 'ok' : 'bad'}>{d.chat ? 'on' : 'off'}</Badge>
                {' · '}
                Language model:{' '}
                <Badge tone={d.llmDisabled ? 'warn' : 'ok'}>
                  {d.llmDisabled ? 'disabled (deterministic only)' : 'allowed'}
                </Badge>
              </p>
              {canEdit && (
                <div className="row">
                  <button
                    className="btn"
                    disabled={busy || !d.chat}
                    onClick={() =>
                      void patch({
                        chat: false,
                        reason: 'Conversation Studio: emergency chat off',
                      })
                    }
                  >
                    Stop chat for this rooftop
                  </button>
                  <button
                    className="btn"
                    disabled={busy || d.chat}
                    onClick={() =>
                      void patch({
                        chat: true,
                        reason: 'Conversation Studio: re-enable chat',
                      })
                    }
                  >
                    Re-enable chat
                  </button>
                  <button
                    className="btn"
                    disabled={busy || d.llmDisabled}
                    onClick={() =>
                      void patch({
                        llmDisabled: true,
                        reason: 'Conversation Studio: disable LLM',
                      })
                    }
                  >
                    Disable LLM
                  </button>
                  <button
                    className="btn"
                    disabled={busy || !d.llmDisabled}
                    onClick={() =>
                      void patch({
                        llmDisabled: false,
                        reason: 'Conversation Studio: re-enable LLM',
                      })
                    }
                  >
                    Allow LLM
                  </button>
                </div>
              )}
            </div>
          </Card>

          <Card title="Versions">
            <p className="small">
              Policy <code>{d.policyVersion}</code>
              {' · '}
              Compose <code>{d.composePromptVersion}</code>
            </p>
            <p className="muted small">
              Playbook draft → preview → approve → publish with example libraries is next. Central truth, consent, and safety rules stay non-overridable.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
