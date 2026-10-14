import { Module } from '@nestjs/common';
import { TradeService } from './trade.service';
import { AppraisalService } from './appraisal.service';

@Module({
  providers: [TradeService, AppraisalService],
  exports: [TradeService, AppraisalService],
})
export class TradeModule {}
