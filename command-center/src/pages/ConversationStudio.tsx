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
              Central truth, consent, and safety rules stay non-overridable by playbooks.
            </p>
          </Card>

          <PlaybooksPanel locationId={locationId} canEdit={canEdit} />
        </>
      )}
    </div>
  );
}

type Playbook = {
  id: string;
  key: string;
  title: string;
  department: string;
  status: string;
  version: number;
  tone: string;
  brevity: string;
  publishedAt: string | null;
};

function PlaybooksPanel({ locationId, canEdit }: { locationId: string; canEdit: boolean }) {
  const list = useAsync(
    () => api<Playbook[]>(`/ops/playbooks?locationId=${encodeURIComponent(locationId)}`),
    [locationId],
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState('');
  const [previewResult, setPreviewResult] = useState<string | null>(null);
  const [form, setForm] = useState({
    key: 'sales-first-response',
    title: 'Sales first response',
    department: 'SALES',
    tone: 'concise',
    brevity: 'short',
    approvedPhrases: 'Good morning!, Happy to help',
    forbiddenPhrases: "I'd be more than happy, Absolutely!",
    good: 'Yes, we have two that match. Want to see both?',
    bad: 'Thank you so much for reaching out today! I would be more than happy to assist you with finding the perfect vehicle...',
  });

  const act = async (path: string, method: 'POST' | 'PATCH' = 'POST', body?: unknown) => {
    setErr(null);
    setBusy(true);
    try {
      await api(path, {
        method,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      await list.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    act(`/ops/playbooks?locationId=${encodeURIComponent(locationId)}`, 'POST', {
      key: form.key,
      title: form.title,
      department: form.department,
      tone: form.tone,
      brevity: form.brevity,
      oneQuestion: true,
      allowRapport: false,
      approvedPhrases: form.approvedPhrases.split(',').map((s) => s.trim()).filter(Boolean),
      forbiddenPhrases: form.forbiddenPhrases.split(',').map((s) => s.trim()).filter(Boolean),
      examples: [{ good: form.good, bad: form.bad, note: 'Owner preference: short natural replies' }],
    });

  return (
    <Card title="Playbooks (draft → review → publish)">
      <ErrorNote error={list.error ?? err} />
      <p className="small">
        Unpublished drafts never change customer replies. Publish requires approval by a different manager when possible. Rollback creates a new published version from history.
      </p>
      {canEdit && (
        <div className="stack" style={{ marginBottom: 12 }}>
          <div className="grid2">
            <label>Key<input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} /></label>
            <label>Title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label>
              Department
              <select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>
                {['GENERAL', 'SALES', 'SERVICE', 'PARTS', 'FINANCE'].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </label>
            <label>
              Tone
              <select value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })}>
                {['concise', 'friendly', 'professional', 'casual', 'premium'].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </label>
          </div>
          <label>Approved phrases (comma-separated)<input value={form.approvedPhrases} onChange={(e) => setForm({ ...form, approvedPhrases: e.target.value })} /></label>
          <label>Forbidden phrases (comma-separated)<input value={form.forbiddenPhrases} onChange={(e) => setForm({ ...form, forbiddenPhrases: e.target.value })} /></label>
          <label>Good example<textarea rows={2} value={form.good} onChange={(e) => setForm({ ...form, good: e.target.value })} /></label>
          <label>Bad example<textarea rows={2} value={form.bad} onChange={(e) => setForm({ ...form, bad: e.target.value })} /></label>
          <button className="btn btn--primary" disabled={busy} onClick={() => void create()}>Create draft playbook</button>
        </div>
      )}
      <ul className="list">
        {(list.data ?? []).map((p) => (
          <li key={p.id} className="stack">
            <span className="row">
              <strong>{p.title}</strong>
              <Badge tone={p.status === 'PUBLISHED' ? 'ok' : p.status === 'PENDING_REVIEW' ? 'warn' : 'neutral'}>
                {p.status} v{p.version}
              </Badge>
              <span className="muted small">{p.department} · {p.tone}/{p.brevity}</span>
            </span>
            {canEdit && (
              <div className="row">
                {(p.status === 'DRAFT' || p.status === 'REJECTED') && (
                  <button className="btn btn--tiny" disabled={busy} onClick={() => void act(`/ops/playbooks/${p.id}/submit`)}>Submit for review</button>
                )}
                {p.status === 'PENDING_REVIEW' && (
                  <button className="btn btn--tiny" disabled={busy} onClick={() => void act(`/ops/playbooks/${p.id}/approve`)}>Approve</button>
                )}
                {(p.status === 'APPROVED' || p.status === 'PUBLISHED') && (
                  <button className="btn btn--tiny btn--primary" disabled={busy} onClick={() => void act(`/ops/playbooks/${p.id}/publish`)}>Publish</button>
                )}
                {(p.status === 'ARCHIVED' || p.status === 'PUBLISHED' || p.status === 'APPROVED') && (
                  <button className="btn btn--tiny" disabled={busy} onClick={() => void act(`/ops/playbooks/${p.id}/rollback`)}>Rollback to this</button>
                )}
                <button
                  className="btn btn--tiny"
                  disabled={busy || !preview.trim()}
                  onClick={() => {
                    setBusy(true);
                    void api<{ ok: boolean; reasons: string[]; sentences: number; questions: number }>(
                      `/ops/playbooks/${p.id}/preview`,
                      { method: 'POST', body: JSON.stringify({ candidate: preview }) },
                    )
                      .then((r) =>
                        setPreviewResult(
                          r.ok
                            ? `OK · ${r.sentences} sentences · ${r.questions} question(s)`
                            : `Needs work: ${r.reasons.join(', ')}`,
                        ),
                      )
                      .catch((e) => setErr(e instanceof Error ? e.message : 'Preview failed'))
                      .finally(() => setBusy(false));
                  }}
                >
                  Preview candidate
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!list.data?.length && !list.loading && <p className="muted small">No playbooks yet for this rooftop.</p>}
      <label>
        Side-by-side candidate reply (safe test text)
        <textarea rows={3} value={preview} onChange={(e) => setPreview(e.target.value)} placeholder="Paste a candidate AI reply to score against a playbook…" />
      </label>
      {previewResult && <p className="banner" role="status">{previewResult}</p>}
    </Card>
  );
}
