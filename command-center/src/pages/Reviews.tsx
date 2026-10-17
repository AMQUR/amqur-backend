import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Badge, Card, ErrorNote } from '../ui';

type GbpReviewsBlockedReason = 'not_connected' | 'not_configured';

type GbpReviewsBlocked = {
  status: 'blocked';
  reason: GbpReviewsBlockedReason;
};

type GbpPendingReview = {
  externalReviewId: string;
  locationId?: string | null;
  comment?: string | null;
  reviewerDisplayName?: string | null;
  createTime?: string | null;
};

type ListPendingReviewsResult =
  | GbpReviewsBlocked
  | { status: 'ok'; reviews: GbpPendingReview[] };

type DraftReplyResult =
  | GbpReviewsBlocked
  | {
      status: 'draft';
      reviewId: string;
      replyText: string;
      published: false;
    };

type PublishReplyResult = GbpReviewsBlocked | { status: 'published'; reviewId: string };

const GBP_BLOCKED: Record<GbpReviewsBlockedReason, string> = {
  not_connected:
    'Google Business Profile is not connected or not live-ready for this rooftop (Integrations → google_business_profile).',
  not_configured:
    'GBP review replies are gated — OAuth and the live adapter are not configured in this environment.',
};

function isGbpBlocked(
  r: ListPendingReviewsResult | DraftReplyResult | PublishReplyResult,
): r is GbpReviewsBlocked {
  return r.status === 'blocked';
}

export function Reviews({ locationId }: { locationId: string }) {
  const pending = useAsync(async () => {
    if (!locationId) return null;
    const q = new URLSearchParams({ locationId });
    return api<ListPendingReviewsResult>(`/ops/reviews/pending?${q}`);
  }, [locationId]);

  const [err, setErr] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replyByReview, setReplyByReview] = useState<Record<string, string>>({});

  useEffect(() => {
    setActionMsg(null);
    setReplyByReview({});
  }, [locationId]);

  const listBlocked = pending.data && isGbpBlocked(pending.data) ? pending.data : null;
  const reviews =
    pending.data && pending.data.status === 'ok' ? pending.data.reviews : [];

  const bodyFor = (replyText: string) => {
    const body: { replyText: string; locationId?: string } = { replyText };
    if (locationId) body.locationId = locationId;
    return body;
  };

  const draft = async (reviewId: string) => {
    const replyText = replyByReview[reviewId]?.trim() ?? '';
    if (!replyText) {
      setErr('Reply text is required to save a draft.');
      return;
    }
    setErr(null);
    setActionMsg(null);
    setBusyId(reviewId);
    try {
      const r = await api<DraftReplyResult>(`/ops/reviews/${encodeURIComponent(reviewId)}/draft`, {
        method: 'POST',
        body: JSON.stringify(bodyFor(replyText)),
      });
      if (isGbpBlocked(r)) {
        setActionMsg({
          tone: 'warn',
          text: GBP_BLOCKED[r.reason] ?? r.reason,
        });
        return;
      }
      setActionMsg({
        tone: 'ok',
        text: `Draft saved locally for review ${r.reviewId} — not published to Google.`,
      });
      await pending.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Draft failed');
    } finally {
      setBusyId(null);
    }
  };

  const publish = async (reviewId: string) => {
    const replyText = replyByReview[reviewId]?.trim() ?? '';
    if (!replyText) {
      setErr('Reply text is required to publish.');
      return;
    }
    setErr(null);
    setActionMsg(null);
    setBusyId(reviewId);
    try {
      const r = await api<PublishReplyResult>(
        `/ops/reviews/${encodeURIComponent(reviewId)}/publish`,
        {
          method: 'POST',
          body: JSON.stringify(bodyFor(replyText)),
        },
      );
      if (isGbpBlocked(r)) {
        setActionMsg({
          tone: 'warn',
          text: GBP_BLOCKED[r.reason] ?? r.reason,
        });
        return;
      }
      if (r.status !== 'published') {
        setActionMsg({
          tone: 'warn',
          text: 'Publish did not complete — no confirmation from GBP.',
        });
        return;
      }
      setActionMsg({
        tone: 'ok',
        text: `Published reply to Google for review ${r.reviewId}.`,
      });
      await pending.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Publish failed');
    } finally {
      setBusyId(null);
    }
  };

  if (!locationId) {
    return (
      <div className="page">
        <h1>Reviews (GBP)</h1>
        <p>Select a rooftop to triage pending Google Business Profile reviews.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Reviews (GBP)</h1>
      <p className="muted">
        Staff triage for Google Business Profile reviews. Drafts stay local until you publish;
        nothing is auto-posted.
      </p>
      <p className="banner banner--warn" role="note">
        Fail-closed: listing, drafting, and publishing require an enabled{' '}
        <code>google_business_profile</code> connection with <code>liveReady</code> and a verified
        GBP adapter.
      </p>
      {listBlocked && (
        <p className="banner" role="status">
          GBP not live — {GBP_BLOCKED[listBlocked.reason] ?? listBlocked.reason}
        </p>
      )}
      <ErrorNote error={pending.error ?? err} />
      {actionMsg && (
        <p
          className={`banner ${actionMsg.tone === 'ok' ? 'banner--ok' : ''}`}
          role="status"
        >
          {actionMsg.text}
        </p>
      )}
      <Card
        title="Pending reviews"
        actions={
          listBlocked ? (
            <Badge tone="bad">blocked</Badge>
          ) : pending.data?.status === 'ok' ? (
            <Badge tone="info">{reviews.length} pending</Badge>
          ) : null
        }
      >
        {pending.loading && <p className="muted">Loading…</p>}
        {!pending.loading && listBlocked && (
          <p className="muted">No reviews loaded while GBP is blocked.</p>
        )}
        {!pending.loading && pending.data?.status === 'ok' && reviews.length === 0 && (
          <p className="muted">No pending reviews returned from GBP.</p>
        )}
        {!listBlocked && reviews.length > 0 && (
          <div className="stack">
            {reviews.map((rev) => {
              const id = rev.externalReviewId;
              const busy = busyId === id;
              return (
                <article key={id} className="card" style={{ padding: '0.75rem 1rem' }}>
                  <header className="card__head">
                    <h2>{rev.reviewerDisplayName?.trim() || 'Anonymous reviewer'}</h2>
                    <span className="muted small">{fmtDate(rev.createTime)}</span>
                  </header>
                  <p>{rev.comment?.trim() || <span className="muted">No comment text</span>}</p>
                  <p className="muted small">
                    Review ID <code>{id}</code>
                  </p>
                  <label>
                    Reply
                    <textarea
                      rows={4}
                      maxLength={4000}
                      value={replyByReview[id] ?? ''}
                      disabled={!!listBlocked}
                      onChange={(e) =>
                        setReplyByReview({ ...replyByReview, [id]: e.target.value })
                      }
                      placeholder="Staff-approved reply (required for draft or publish)"
                    />
                  </label>
                  <div className="row">
                    <button
                      className="btn"
                      disabled={busy || !!listBlocked}
                      onClick={() => void draft(id)}
                    >
                      {busy ? 'Saving…' : 'Save draft'}
                    </button>
                    <button
                      className="btn btn--primary"
                      disabled={busy || !!listBlocked}
                      onClick={() => void publish(id)}
                    >
                      {busy ? 'Publishing…' : 'Publish to GBP'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
