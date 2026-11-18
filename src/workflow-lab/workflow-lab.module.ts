import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { WorkflowLabController } from './workflow-lab.controller';
import { WorkflowPreviewService } from './workflow-preview.service';

@Module({
  imports: [KnowledgeModule],
  providers: [WorkflowPreviewService],
  controllers: [WorkflowLabController],
})
export class WorkflowLabModule {}
