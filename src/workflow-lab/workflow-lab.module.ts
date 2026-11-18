import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { WorkflowLabController } from './workflow-lab.controller';
import { WorkflowDefinitionController } from './workflow-definition.controller';
import { WorkflowDefinitionService } from './workflow-definition.service';
import { WorkflowPreviewService } from './workflow-preview.service';

@Module({
  imports: [KnowledgeModule],
  providers: [WorkflowPreviewService, WorkflowDefinitionService],
  controllers: [WorkflowLabController, WorkflowDefinitionController],
})
export class WorkflowLabModule {}
