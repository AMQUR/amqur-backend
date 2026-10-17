import { Module } from '@nestjs/common';
import { TradeService } from './trade.service';
import { AppraisalService } from './appraisal.service';
import { TradeValuationController } from './trade-valuation.controller';

@Module({
  controllers: [TradeValuationController],
  providers: [TradeService, AppraisalService],
  exports: [TradeService, AppraisalService],
})
export class TradeModule {}
