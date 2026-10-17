/**
 * Google Business Profile review reply contracts — no live GBP API calls.
 * Never invent star ratings or auto-post replies.
 */
export type GbpReviewsBlockedReason = 'not_connected' | 'not_configured';

export type GbpReviewsBlocked = {
  status: 'blocked';
  reason: GbpReviewsBlockedReason;
};

export type GbpPendingReview = {
  externalReviewId: string;
  locationId?: string | null;
  comment?: string | null;
  reviewerDisplayName?: string | null;
  createTime?: string | null;
};

export type ListPendingReviewsParams = {
  tenantId: string;
  locationId?: string | null;
};

export type ListPendingReviewsResult =
  | GbpReviewsBlocked
  | { status: 'ok'; reviews: GbpPendingReview[] };

export type DraftReplyParams = {
  tenantId: string;
  locationId?: string | null;
  reviewId: string;
  replyText: string;
};

export type DraftReplyResult =
  | GbpReviewsBlocked
  | {
      status: 'draft';
      reviewId: string;
      replyText: string;
      published: false;
    };

export type PublishReplyParams = {
  tenantId: string;
  locationId?: string | null;
  reviewId: string;
  replyText: string;
};

export type PublishReplyResult =
  | GbpReviewsBlocked
  | { status: 'published'; reviewId: string };

export function gbpReviewsBlocked(
  reason: GbpReviewsBlockedReason,
): GbpReviewsBlocked {
  return { status: 'blocked', reason };
}

export interface GbpReviewsProvider {
  readonly providerId: string;
  isLiveConfigured(): boolean;
  listPendingReviews(
    params: ListPendingReviewsParams,
  ): Promise<ListPendingReviewsResult>;
  draftReply(params: DraftReplyParams): Promise<DraftReplyResult>;
  publishReply(params: PublishReplyParams): Promise<PublishReplyResult>;
}

/** Stub until GBP OAuth + API scopes are approved and verified in staging. */
export class DisabledGbpReviewsProvider implements GbpReviewsProvider {
  readonly providerId = 'disabled';

  isLiveConfigured(): boolean {
    return false;
  }

  async listPendingReviews(
    _params: ListPendingReviewsParams,
  ): Promise<ListPendingReviewsResult> {
    return gbpReviewsBlocked('not_configured');
  }

  async draftReply(_params: DraftReplyParams): Promise<DraftReplyResult> {
    return gbpReviewsBlocked('not_configured');
  }

  async publishReply(_params: PublishReplyParams): Promise<PublishReplyResult> {
    return gbpReviewsBlocked('not_configured');
  }
}
