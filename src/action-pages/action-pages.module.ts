import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ActionPagesController } from './action-pages.controller';
import { ActionPagesService } from './action-pages.service';

@Module({
  imports: [PrismaModule],
  controllers: [ActionPagesController],
  providers: [ActionPagesService],
  exports: [ActionPagesService],
})
export class ActionPagesModule {}
