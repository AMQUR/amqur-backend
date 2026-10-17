import { Module } from '@nestjs/common';
import { DealsController } from './deals.controller';
import { SoldDealService } from './sold-deal.service';

@Module({
  controllers: [DealsController],
  providers: [SoldDealService],
  exports: [SoldDealService],
})
export class DealsModule {}
