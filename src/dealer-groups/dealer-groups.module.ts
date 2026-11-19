import { Module } from '@nestjs/common';
import { DealerGroupsService } from './dealer-groups.service';
import { DealerGroupsController } from './dealer-groups.controller';
import { GroupOverviewService } from './overview/group-overview.service';
import { LeadFunnelService } from '../operations/funnel/lead-funnel.service';

@Module({
  controllers: [DealerGroupsController],
  providers: [DealerGroupsService, GroupOverviewService, LeadFunnelService],
  exports: [DealerGroupsService],
})
export class DealerGroupsModule {}
