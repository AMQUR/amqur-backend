import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { CallQaService } from './call-qa.service';

class CallQaBodyBase {
  @IsOptional() @IsString() @MaxLength(64) locationId?: string;
}

class SummarizeCallDto extends CallQaBodyBase {
  @IsString() @MinLength(1) @MaxLength(128) externalCallId!: string;
  @IsOptional() @IsString() @MaxLength(200_000) transcript?: string;
}

class ScoreCallDto extends CallQaBodyBase {
  @IsString() @MinLength(1) @MaxLength(128) externalCallId!: string;
  @IsOptional() @IsString() @MaxLength(200_000) transcript?: string;
}

@Controller('ops/call-qa')
@UseGuards(RolesGuard)
export class CallQaController {
  constructor(private readonly callQa: CallQaService) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get('coaching-tips')
  listCoachingTips(
    @CurrentUser() u: AuthUser,
    @Query('locationId') locationId?: string,
    @Query('externalCallId') externalCallId?: string,
  ) {
    assertStaffRole(u);
    const tenantId = resolveTenantId(u);
    const scopedLocation = resolveLocationScope(u, locationId);
    return this.callQa.listCoachingTips({
      tenantId,
      locationId: scopedLocation ?? locationId ?? null,
      externalCallId: externalCallId ?? null,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('summarize')
  summarize(@CurrentUser() u: AuthUser, @Body() body: SummarizeCallDto) {
    assertStaffRole(u);
    const tenantId = resolveTenantId(u);
    const scopedLocation = resolveLocationScope(u, body.locationId);
    return this.callQa.summarizeCall({
      tenantId,
      locationId: scopedLocation ?? body.locationId ?? null,
      externalCallId: body.externalCallId,
      transcript: body.transcript ?? null,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('score')
  score(@CurrentUser() u: AuthUser, @Body() body: ScoreCallDto) {
    assertStaffRole(u);
    const tenantId = resolveTenantId(u);
    const scopedLocation = resolveLocationScope(u, body.locationId);
    return this.callQa.scoreCall({
      tenantId,
      locationId: scopedLocation ?? body.locationId ?? null,
      externalCallId: body.externalCallId,
      transcript: body.transcript ?? null,
    });
  }
}
