import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { WorkflowPreviewService } from './workflow-preview.service';

class WorkflowPreviewDto {
  @IsObject()
  graph!: Record<string, unknown>;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  query!: string;

  @IsOptional()
  @IsString()
  locationId?: string;
}

/** Disabled for customer JWTs. Does not create jobs, update CRM or execute tools. */
@Controller('ops/workflow-lab')
@UseGuards(RolesGuard)
export class WorkflowLabController {
  constructor(private readonly workflows: WorkflowPreviewService) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('preview')
  preview(@CurrentUser() user: AuthUser, @Body() body: WorkflowPreviewDto) {
    return this.workflows.preview(body.graph, {
      tenantId: resolveTenantId(user),
      locationId: resolveLocationScope(user, body.locationId),
      query: body.query,
    });
  }
}
