import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { toActor } from './workflow-definition.controller';
import { WorkflowRunService } from './workflow-run.service';

class StartRunDto {
  @IsString() @MinLength(1) @MaxLength(64) definitionId!: string;
  @IsString() @MinLength(1) @MaxLength(300) query!: string;
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  idempotencyKey?: string;
}

class RunDecisionDto {
  @IsIn(['APPROVE', 'DENY']) decision!: 'APPROVE' | 'DENY';
}

/** Staff-only SIMULATION runs of published workflow versions. No tools, CRM or customer effects. */
@Controller('ops/workflow-lab/runs')
@UseGuards(RolesGuard)
@Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
export class WorkflowRunController {
  constructor(private readonly runs: WorkflowRunService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('definitionId') definitionId?: string,
  ) {
    return this.runs.list(toActor(user), definitionId);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  start(@CurrentUser() user: AuthUser, @Body() dto: StartRunDto) {
    return this.runs.start(toActor(user), dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.runs.get(toActor(user), id);
  }

  @Post(':id/decision')
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RunDecisionDto,
  ) {
    return this.runs.decide(toActor(user), id, dto.decision);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.runs.cancel(toActor(user), id);
  }
}
