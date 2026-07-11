import { Module } from '@nestjs/common';
import { FollowUpEngineService } from './follow-up-engine.service';

@Module({
  providers: [FollowUpEngineService],
  exports: [FollowUpEngineService],
})
export class FollowUpModule {}
