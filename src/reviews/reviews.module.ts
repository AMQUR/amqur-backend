import { Module } from '@nestjs/common';
import { ReviewsController } from './reviews.controller';
import { GbpReviewsService } from './gbp-reviews.service';

@Module({
  controllers: [ReviewsController],
  providers: [GbpReviewsService],
  exports: [GbpReviewsService],
})
export class ReviewsModule {}
