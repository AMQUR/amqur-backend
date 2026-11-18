import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { WorkflowLabController } from './workflow-lab.controller';
import { WorkflowDefinitionController } from './workflow-definition.controller';
import { WorkflowDefinitionService } from './workflow-definition.service';
import { WorkflowRunController } from './workflow-run.controller';
import { WorkflowRunService } from './workflow-run.service';
import { WorkflowPreviewService } from './workflow-preview.service';

@Module({
  imports: [KnowledgeModule],
  providers: [
    WorkflowPreviewService,
    WorkflowDefinitionService,
    WorkflowRunService,
  ],
  controllers: [
    WorkflowLabController,
    WorkflowDefinitionController,
    WorkflowRunController,
  ],
})
export class WorkflowLabModule {}
