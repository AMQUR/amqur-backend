import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TradeModule } from '../trade/trade.module';
import { ActionPagesController } from './action-pages.controller';
import { ActionPagesService } from './action-pages.service';

@Module({
  imports: [PrismaModule, TradeModule],
  controllers: [ActionPagesController],
  providers: [ActionPagesService],
  exports: [ActionPagesService],
})
export class ActionPagesModule {}
