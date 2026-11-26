import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DealerKnowledgeService } from './dealer-knowledge.service';

/** Shared dealership knowledge for the Concierge and CRM Workforce. */
@Module({
  imports: [PrismaModule],
  providers: [DealerKnowledgeService],
  exports: [DealerKnowledgeService],
})
export class DealerKnowledgeModule {}
