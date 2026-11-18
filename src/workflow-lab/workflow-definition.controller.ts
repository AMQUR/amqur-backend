import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  resolveTenantId,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import {
  WorkflowDefinitionService,
  type WorkflowActor,
} from './workflow-definition.service';

class CreateWorkflowDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsObject() graph!: Record<string, unknown>;
  @IsOptional() @IsString() locationId?: string;
}

class UpdateWorkflowDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsObject() graph?: Record<string, unknown>;
}

class DecisionDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class RollbackDto {
  @IsInt() @Min(1) @Max(1_000_000) toVersion!: number;
}

/** Tenant, actor and rooftop binding come only from the verified JWT. */
export function toActor(user: AuthUser): WorkflowActor {
  return {
    tenantId: resolveTenantId(user),
    userId: user.sub,
    boundLocationId:
      (user.role === 'STAFF' || user.role === 'MANAGER') && user.locationId
        ? user.locationId
        : null,
  };
}

/** Staff-only authoring/review of versioned workflows. Never executes anything. */
@Controller('ops/workflow-lab/definitions')
@UseGuards(RolesGuard)
@Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
export class WorkflowDefinitionController {
  constructor(private readonly defs: WorkflowDefinitionService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.defs.list(toActor(user));
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkflowDto) {
    return this.defs.create(toActor(user), dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.defs.get(toActor(user), id);
  }

  @Get(':id/versions')
  versions(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.defs.versions(toActor(user), id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateWorkflowDto,
  ) {
    return this.defs.updateDraft(toActor(user), id, dto);
  }

  @Post(':id/request-review')
  requestReview(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.defs.requestReview(toActor(user), id);
  }

  @Post(':id/approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.defs.approveAndPublish(toActor(user), id, dto.note);
  }

  @Post(':id/deny')
  deny(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.defs.deny(toActor(user), id);
  }

  @Post(':id/rollback')
  rollback(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RollbackDto,
  ) {
    return this.defs.rollback(toActor(user), id, dto.toVersion);
  }
}
