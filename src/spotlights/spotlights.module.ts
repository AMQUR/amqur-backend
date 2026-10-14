import { Module } from '@nestjs/common';
import { SpotlightsController } from './spotlights.controller';
import { SpotlightsService } from './spotlights.service';

@Module({
  controllers: [SpotlightsController],
  providers: [SpotlightsService],
  exports: [SpotlightsService],
})
export class SpotlightsModule {}
