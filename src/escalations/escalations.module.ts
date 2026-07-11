import { Module } from '@nestjs/common';
import { EscalationsService } from './escalations.service';
import { EscalationsController } from './escalations.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [EscalationsController],
  providers: [EscalationsService],
  exports: [EscalationsService],
})
export class EscalationsModule {}
