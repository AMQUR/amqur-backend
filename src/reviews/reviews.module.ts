import { Module } from '@nestjs/common';
import { ReviewsController } from './reviews.controller';
import { ReviewRequestIntentsController } from './review-request-intents.controller';
import { GbpReviewsService } from './gbp-reviews.service';
import { ReviewRequestIntentService } from './review-request-intent.service';

@Module({
  controllers: [ReviewsController, ReviewRequestIntentsController],
  providers: [GbpReviewsService, ReviewRequestIntentService],
  exports: [GbpReviewsService, ReviewRequestIntentService],
})
export class ReviewsModule {}
