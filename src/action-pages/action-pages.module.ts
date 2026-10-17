import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TradeModule } from '../trade/trade.module';
import { PartsModule } from '../parts/parts.module';
import { ActionPagesController } from './action-pages.controller';
import { ActionPagesService } from './action-pages.service';

@Module({
  imports: [PrismaModule, TradeModule, PartsModule],
  controllers: [ActionPagesController],
  providers: [ActionPagesService],
  exports: [ActionPagesService],
})
export class ActionPagesModule {}
