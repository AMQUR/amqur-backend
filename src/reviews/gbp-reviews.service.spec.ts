import {
  GBP_REVIEWS_CAPABILITY,
  GbpReviewsService,
} from './gbp-reviews.service';

describe('GbpReviewsService (fail-closed)', () => {
  const prisma = {
    integrationConnection: { findFirst: jest.fn() },
  };
  const svc = new GbpReviewsService(prisma as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.integrationConnection.findFirst.mockResolvedValue(null);
  });

  it('publishReply returns not_connected when no live GBP integration exists', async () => {
    const result = await svc.publishReply({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      reviewId: 'review-ext-1',
      replyText: 'Thank you for visiting us.',
    });

    expect(result).toEqual({ status: 'blocked', reason: 'not_connected' });
    expect(prisma.integrationConnection.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        capability: GBP_REVIEWS_CAPABILITY,
        enabled: true,
        liveReady: true,
        OR: [{ locationId: 'loc-1' }, { locationId: null }],
      },
      select: { id: true },
    });
  });

  it('listPendingReviews does not invent reviews when GBP is not connected', async () => {
    const result = await svc.listPendingReviews({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
    });

    expect(result).toEqual({ status: 'blocked', reason: 'not_connected' });
  });
});
