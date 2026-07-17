import { Module } from '@nestjs/common';
import { DealerGroupsService } from './dealer-groups.service';
import { DealerGroupsController } from './dealer-groups.controller';

@Module({
  controllers: [DealerGroupsController],
  providers: [DealerGroupsService],
  exports: [DealerGroupsService],
})
export class DealerGroupsModule {}
