import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ToolActionService } from './tool-action.service';
import { ToolActionExecutor } from './tool-action.executor';
import { ToolRegistryController } from './tool-registry.controller';

@Module({
  imports: [IntegrationsModule],
  providers: [ToolActionService, ToolActionExecutor],
  controllers: [ToolRegistryController],
  exports: [ToolActionService],
})
export class ToolRegistryModule {}
