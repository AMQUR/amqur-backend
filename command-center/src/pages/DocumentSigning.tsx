import { useState } from 'react';
import { api } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Badge, Card, ErrorNote } from '../ui';

type DocSigningBlockedReason = 'not_connected' | 'not_configured';

type DocSigningBlocked = {
  status: 'blocked';
  reason: DocSigningBlockedReason;
};

type CreateEnvelopeResult =
  | DocSigningBlocked
  | { status: 'pending'; envelopeId: string; signed: false };

type GetEnvelopeStatusResult =
  | DocSigningBlocked
  | { status: 'pending' | 'declined' | 'voided'; envelopeId: string; signed: false }
  | { status: 'completed'; envelopeId: string; signed: true; completedAt: string };

const DOC_SIGN_BLOCKED: Record<DocSigningBlockedReason, string> = {
  not_connected:
    'E-sign is not connected — enable a live-ready document_signing integration for this rooftop (Integrations).',
  not_configured:
    'E-sign provider adapter is not configured in this environment — envelopes cannot be created or polled until vendor OAuth is verified.',
};

function isDocBlocked(
  r: CreateEnvelopeResult | GetEnvelopeStatusResult | null | undefined,
): r is DocSigningBlocked {
  return !!r && r.status === 'blocked';
}

export function DocumentSigning({ locationId }: { locationId: string }) {
  const [documentRef, setDocumentRef] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [signerName, setSignerName] = useState('');
  const [envelopeId, setEnvelopeId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [requestResult, setRequestResult] = useState<CreateEnvelopeResult | null>(null);
  const [busy, setBusy] = useState<'request' | null>(null);

  const pollId = envelopeId.trim();

  const status = useAsync(async () => {
    if (!pollId) return null;
    const q = new URLSearchParams({ envelopeId: pollId });
    if (locationId) q.set('locationId', locationId);
    return api<GetEnvelopeStatusResult>(`/documents/sign/status?${q}`);
  }, [locationId, pollId]);

  const statusBlocked = status.data && isDocBlocked(status.data) ? status.data : null;

  const bodyForRequest = () => {
    const body: {
      documentRef: string;
      locationId?: string;
      signerEmail?: string;
      signerName?: string;
    } = { documentRef: documentRef.trim() };
    if (locationId) body.locationId = locationId;
    const email = signerEmail.trim();
    if (email) body.signerEmail = email;
    const name = signerName.trim();
    if (name) body.signerName = name;
    return body;
  };

  const requestSign = async () => {
    const ref = documentRef.trim();
    if (!ref) {
      setErr('Document reference is required.');
      return;
    }
    setErr(null);
    setRequestResult(null);
    setBusy('request');
    try {
      const r = await api<CreateEnvelopeResult>('/documents/sign/request', {
        method: 'POST',
        body: JSON.stringify(bodyForRequest()),
      });
      setRequestResult(r);
      if (r.status === 'pending') {
        setEnvelopeId(r.envelopeId);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign request failed');
    } finally {
      setBusy(null);
    }
  };

  if (!locationId) {
    return (
      <div className="page">
        <h1>Document signing</h1>
        <p>Select a rooftop to request e-sign envelopes.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Document signing</h1>
      <p className="muted">
        Request e-sign envelopes for deal paperwork. Status is never reported as signed unless a
        live provider confirms completion.
      </p>
      <p className="banner banner--warn" role="note">
        Fail-closed: requests return <code>not_connected</code> without a live-ready{' '}
        <code>document_signing</code> integration; even with a connection, this environment uses a
        disabled adapter until vendor OAuth is verified (<code>not_configured</code>).
      </p>
      <ErrorNote error={status.error ?? err} />

      <Card title="Request envelope">
        <div className="stack">
          <label>
            Document reference
            <input
              required
              maxLength={256}
              value={documentRef}
              onChange={(e) => setDocumentRef(e.target.value)}
              placeholder="CRM doc id, deal packet name, or storage key"
            />
          </label>
          <label>
            Signer email <span className="muted small">(optional)</span>
            <input
              type="email"
              maxLength={320}
              value={signerEmail}
              onChange={(e) => setSignerEmail(e.target.value)}
              placeholder="buyer@example.com"
            />
          </label>
          <label>
            Signer name <span className="muted small">(optional)</span>
            <input
              maxLength={200}
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
              placeholder="Customer legal name"
            />
          </label>
          <button
            className="btn btn--primary"
            disabled={!documentRef.trim() || busy !== null}
            onClick={() => void requestSign()}
          >
            {busy === 'request' ? 'Submitting…' : 'Request signature'}
          </button>
        </div>
      </Card>

      {requestResult && (
        <p
          className={`banner ${requestResult.status === 'pending' ? 'banner--ok' : ''}`}
          role="status"
        >
          {isDocBlocked(requestResult) ? (
            <>
              Request blocked —{' '}
              {DOC_SIGN_BLOCKED[requestResult.reason] ?? requestResult.reason}
            </>
          ) : (
            <>
              Envelope <code>{requestResult.envelopeId}</code> created (pending).{' '}
              <Badge tone="neutral">signed: false</Badge>
            </>
          )}
        </p>
      )}

      <Card
        title="Envelope status"
        actions={
          statusBlocked ? (
            <Badge tone="bad">blocked</Badge>
          ) : status.data && status.data.status === 'completed' ? (
            <Badge tone="ok">completed</Badge>
          ) : pollId ? (
            <Badge tone="info">polling</Badge>
          ) : null
        }
      >
        <div className="stack">
          <label>
            Envelope ID
            <input
              maxLength={128}
              value={envelopeId}
              onChange={(e) => setEnvelopeId(e.target.value)}
              placeholder="From a successful request or your e-sign vendor"
            />
          </label>
          {!pollId && (
            <p className="muted">Enter an envelope ID to poll status (auto-filled after a pending request).</p>
          )}
          {pollId && status.loading && <p className="muted">Loading status…</p>}
          {pollId && statusBlocked && (
            <p className="banner" role="status">
              Status unavailable — {DOC_SIGN_BLOCKED[statusBlocked.reason] ?? statusBlocked.reason}
            </p>
          )}
          {pollId && status.data && !isDocBlocked(status.data) && status.data.status !== 'completed' && (
            <ul className="kv">
              <li>
                <span>State</span>
                <Badge tone="warn">{status.data.status}</Badge>
              </li>
              <li>
                <span>Signed</span>
                <Badge tone="neutral">{String(status.data.signed)}</Badge>
              </li>
            </ul>
          )}
          {pollId && status.data?.status === 'completed' && (
            <ul className="kv">
              <li>
                <span>State</span>
                <Badge tone="ok">completed</Badge>
              </li>
              <li>
                <span>Completed</span>
                {fmtDate(status.data.completedAt)}
              </li>
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
