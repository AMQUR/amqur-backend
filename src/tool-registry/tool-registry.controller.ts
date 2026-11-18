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
import { ToolActionStatus } from '@prisma/client';
import {
  IsIn,
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
  resolveTenantId,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { ToolActionService, type ToolActor } from './tool-action.service';

class ProposeDto {
  @IsString() @MinLength(1) @MaxLength(64) tool!: string;
  @IsObject() input!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(64) locationId?: string;
  @IsOptional() @IsString() @MaxLength(100) consentRef?: string;
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  idempotencyKey?: string;
}

class DecisionDto {
  @IsIn(['APPROVE', 'DENY']) decision!: 'APPROVE' | 'DENY';
  @IsOptional() @IsString() @MaxLength(64) reviewedChecksum?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

/** Tenant, role and rooftop binding come only from the verified JWT. */
export function toToolActor(user: AuthUser): ToolActor {
  return {
    tenantId: resolveTenantId(user),
    userId: user.sub,
    role: user.role,
    boundLocationId:
      (user.role === 'STAFF' || user.role === 'MANAGER') && user.locationId
        ? user.locationId
        : null,
  };
}

/** Staff approval inbox for tool actions. Mock providers only; everything ships disabled. */
@Controller('ops/tools')
@UseGuards(RolesGuard)
@Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
export class ToolRegistryController {
  constructor(private readonly actions: ToolActionService) {}

  @Get('catalog')
  catalog() {
    return this.actions.catalog();
  }

  @Get('actions')
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    const valid = Object.values(ToolActionStatus) as string[];
    return this.actions.list(
      toToolActor(user),
      status && valid.includes(status)
        ? (status as ToolActionStatus)
        : undefined,
    );
  }

  @Post('actions')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  propose(@CurrentUser() user: AuthUser, @Body() dto: ProposeDto) {
    return this.actions.propose(toToolActor(user), dto);
  }

  @Get('actions/:id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.actions.get(toToolActor(user), id);
  }

  @Post('actions/:id/decision')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.actions.decide(toToolActor(user), id, dto.decision, dto);
  }

  @Post('actions/:id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.actions.cancel(toToolActor(user), id);
  }
}
