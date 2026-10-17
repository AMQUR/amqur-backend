import { useState } from 'react';
import { api } from './api';
import { Badge, statusTone } from './ui';

export type EscalationRow = {
  id: string;
  reason: string;
  urgency: string;
  status: string;
  summary?: string | null;
  notifiedAt?: string | null;
  createdAt?: string;
  conversationId?: string | null;
};

const OPEN_STATUSES = new Set(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS']);

export function isOpenEscalation(status: string): boolean {
  return OPEN_STATUSES.has(status);
}

async function postEscalation(id: string, action: 'acknowledge' | 'claim' | 'resolve', body?: { note?: string }) {
  return api<EscalationRow>(`/escalations/${id}/${action}`, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Staff workflow for open handoffs — uses /escalations API (audit via EscalationsService). */
export function EscalationActions(props: {
  escalation: EscalationRow;
  onUpdated: () => void;
  showResolveNote?: boolean;
}) {
  const { escalation: e } = props;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [resolveNote, setResolveNote] = useState('');
  const [showResolve, setShowResolve] = useState(false);

  if (!isOpenEscalation(e.status)) {
    return <Badge tone={statusTone(e.status)}>{e.status.replace(/_/g, ' ').toLowerCase()}</Badge>;
  }

  const run = async (action: 'acknowledge' | 'claim' | 'resolve', note?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await postEscalation(e.id, action, note !== undefined ? { note } : undefined);
      setMsg(action === 'resolve' ? 'Resolved' : action === 'claim' ? 'In progress' : 'Acknowledged');
      setShowResolve(false);
      setResolveNote('');
      props.onUpdated();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="stack small">
      <span className="row">
        <Badge tone={statusTone(e.status)}>{e.status.replace(/_/g, ' ').toLowerCase()}</Badge>
        {e.status === 'OPEN' && (
          <>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void run('acknowledge')}>
              Acknowledge
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void run('claim')}>
              Start work
            </button>
          </>
        )}
        {e.status === 'ACKNOWLEDGED' && (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void run('claim')}>
            Start work
          </button>
        )}
        {!showResolve && (
          <button type="button" className="btn" disabled={busy} onClick={() => setShowResolve(true)}>
            Resolve
          </button>
        )}
      </span>
      {showResolve && (
        <span className="row">
          {(props.showResolveNote ?? true) && (
            <input
              value={resolveNote}
              onChange={(ev) => setResolveNote(ev.target.value)}
              placeholder="Resolve note (optional, internal)"
              aria-label="Resolve note"
            />
          )}
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void run('resolve', resolveNote.trim() || undefined)}
          >
            Confirm resolve
          </button>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setShowResolve(false)}>
            Cancel
          </button>
        </span>
      )}
      {msg && <span className="muted">{msg}</span>}
    </span>
  );
}
