import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { OperationsService } from './operations.service';
import { ConversationIdService } from '../chat/conversation-id.service';
import { CreditDestinationAdminService } from '../finance/credit-destination-admin.service';
import { CREDIT_LINK_TYPES } from '../finance/credit-destination';
import { RooftopReadinessService } from './rooftop-readiness';
import { AppraisalService } from '../trade/appraisal.service';
import { IsNumber, Max, Min } from 'class-validator';
import type { CreditLinkType } from '../finance/credit-destination';

class TextDto {
  @IsString() @MinLength(1) @MaxLength(4000) text!: string;
}
class TransferDto {
  @IsString() toUserId!: string;
}
class ReplayDto {
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) ids!: string[];
}
class LocationOpsDto {
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsObject() storeHours?: Record<string, unknown> | null;
  @IsOptional() @IsObject() departmentHours?: Record<string, unknown> | null;
  @IsOptional() @IsArray() holidayHours?: unknown[];
  @IsOptional() @IsBoolean() verifyHours?: boolean;
  @IsOptional() @IsObject() financialPolicy?: Record<string, unknown>;
  @IsOptional() @IsObject() creditApplication?: Record<string, unknown>;
  @IsOptional() @IsObject() serviceAmenities?: Record<string, unknown> | null;
  /** { quietStart?: "21:00", quietEnd?: "08:00", maxMarketingPer24h?: number } */
  @IsOptional() @IsObject() messagingPolicy?: Record<string, unknown> | null;
}

class CreditDestinationDto {
  /** Write-only. Never echoed back; stored AES-256-GCM encrypted. */
  @IsString() @MinLength(12) @MaxLength(2048) url!: string;
  @IsOptional() @IsString() @MaxLength(60) providerName?: string;
  @IsOptional() @IsString() @MaxLength(60) label?: string;
  @IsOptional() @IsIn(CREDIT_LINK_TYPES) linkType?: CreditLinkType;
  @IsOptional() @IsBoolean() demoPreview?: boolean;
  @IsOptional() @IsBoolean() enable?: boolean;
}
class AiControlDto {
  @IsOptional() @IsBoolean() chat?: boolean;
  @IsOptional() @IsBoolean() llmDisabled?: boolean;
  /** Opt into longer replies; default platform behavior is concise 1–2 sentences. */
  @IsOptional() @IsBoolean() verboseReplies?: boolean;
  /** Optional daypart/rapport; never invents weather/sports. */
  @IsOptional() @IsBoolean() contextualRapport?: boolean;
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class AppraisalDto {
  @IsNumber() @Min(1) @Max(500000) amount!: number;
  @IsOptional() @IsString() @MaxLength(200) conditionBasis?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsBoolean() showToCustomer?: boolean;
}
class OfferDto {
  @IsNumber() @Min(1) @Max(500000) amount!: number;
  @IsNumber() @Min(1) @Max(30) validDays!: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
class CreditAuthorizeDto {
  @IsIn(CREDIT_LINK_TYPES) linkType!: CreditLinkType;
  @IsString() @MinLength(6) @MaxLength(200) evidenceRef!: string;
}

const REPLY_FEEDBACK = [
  'too_long',
  'sounds_robotic',
  'wrong_facts',
  'wrong_question',
  'good_reply',
  'needed_human',
  'unnecessary_weather_sports',
] as const;

class ReplyFeedbackDto {
  @IsString() @MinLength(1) @MaxLength(64) conversationId!: string;
  @IsOptional() @IsString() @MaxLength(64) messageId?: string;
  @IsIn(REPLY_FEEDBACK) label!: (typeof REPLY_FEEDBACK)[number];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

const STAFF = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'] as const;

@Controller('ops')
@UseGuards(RolesGuard)
export class OperationsController {
  constructor(
    private readonly ops: OperationsService,
    private readonly creditAdmin: CreditDestinationAdminService,
    private readonly readiness: RooftopReadinessService,
    private readonly appraisals: AppraisalService,
  ) {}

  // ── trade-in appraisal workflow (staff records; managers issue offers)

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get('appraisal-providers')
  appraisalProviders() {
    return this.appraisals.providerStatus();
  }

  @Roles(...STAFF)
  @Get('trades/:id/appraisals')
  listAppraisals(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.appraisals.list(this.scope(u).tenantId, id);
  }

  @Roles(...STAFF)
  @Post('trades/:id/appraisals')
  recordAppraisal(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: AppraisalDto,
  ) {
    return this.appraisals.recordAppraisal(
      this.scope(u).tenantId,
      { id: u.sub, role: u.role },
      id,
      b,
    );
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('trades/:id/offer')
  issueOffer(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: OfferDto,
  ) {
    return this.appraisals.issueOffer(
      this.scope(u).tenantId,
      { id: u.sub, role: u.role },
      id,
      b,
    );
  }

  /** Group-level five-rooftop readiness scorecard (platform admins only). */
  @Roles('SUPER_ADMIN')
  @Get('group/readiness')
  groupReadiness(@CurrentUser() u: AuthUser) {
    assertStaffRole(u);
    return this.readiness.scorecard();
  }

  private scope(user: AuthUser, tenantId?: string, locationId?: string) {
    assertStaffRole(user);
    return {
      tenantId: resolveTenantId(user, tenantId),
      locationId: resolveLocationScope(user, locationId),
    };
  }

  @Roles(...STAFF)
  @Get('overview')
  overview(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.ops.overview(this.scope(u, t, l));
  }

  @Roles(...STAFF)
  @Get('daily-brief')
  dailyBrief(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.ops.dailyBrief(this.scope(u, t, l));
  }

  @Roles(...STAFF)
  @Get('queues')
  queues(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.ops.queues(this.scope(u, t, l));
  }

  @Roles(...STAFF)
  @Get('satisfaction')
  satisfaction(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.ops.satisfaction(this.scope(u, t, l));
  }

  @Roles(...STAFF)
  @Get('missed-opportunities')
  missedOpportunities(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.ops.missedOpportunities(this.scope(u, t, l));
  }

  @Roles(...STAFF)
  @Get('inbox')
  inbox(
    @CurrentUser() u: AuthUser,
    @Query('q') q?: string,
    @Query('handoff') handoff?: 'open' | 'all',
    @Query('mine') mine?: string,
    @Query('cursor') cursor?: string,
    @Query('locationId') l?: string,
    @Query('tenantId') t?: string,
  ) {
    return this.ops.inbox(this.scope(u, t, l), {
      q: q?.slice(0, 100),
      handoff,
      assignedTo: mine === 'true' ? u.sub : undefined,
      cursor,
    });
  }

  @Roles(...STAFF)
  @Get('conversations/:id')
  conversation(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.ops.conversation(this.scope(u), id);
  }

  @Roles(...STAFF)
  @Post('conversations/:id/takeover')
  takeover(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.ops.takeover(this.scope(u), id, u.sub);
  }

  @Roles(...STAFF)
  @Post('conversations/:id/transfer')
  transfer(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: TransferDto,
  ) {
    return this.ops.transfer(this.scope(u), id, u.sub, b.toUserId);
  }

  @Roles(...STAFF)
  @Post('conversations/:id/release')
  release(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.ops.release(this.scope(u), id, u.sub);
  }

  @Roles(...STAFF)
  @Post('conversations/:id/reply')
  reply(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: TextDto,
  ) {
    return this.ops.staffReply(this.scope(u), id, u.sub, b.text);
  }

  @Roles(...STAFF)
  @Post('conversations/:id/notes')
  note(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: TextDto,
  ) {
    return this.ops.note(this.scope(u), id, u.sub, b.text);
  }

  @Roles(...STAFF)
  @Get('search')
  search(
    @CurrentUser() u: AuthUser,
    @Query('q') q: string,
    @Query('locationId') l?: string,
  ) {
    return this.ops.search(
      this.scope(u, undefined, l),
      (q ?? '').slice(0, 100),
    );
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get('integrations')
  integrations(@CurrentUser() u: AuthUser, @Query('locationId') l?: string) {
    return this.ops.integrations(this.scope(u, undefined, l));
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get('outbox/dead')
  dead(@CurrentUser() u: AuthUser) {
    return this.ops.deadLetters(this.scope(u));
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post('outbox/replay')
  replay(@CurrentUser() u: AuthUser, @Body() b: ReplayDto) {
    return this.ops.replay(this.scope(u), b.ids, u.sub);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get('locations/:id/settings')
  settings(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const s = this.scope(u, undefined, id);
    return this.ops.locationSettings(s.tenantId, s.locationId ?? id);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Get('ai/status')
  aiStatus(@CurrentUser() u: AuthUser) {
    return this.ops.aiStatus(u.tenantId);
  }

  /** Unified, read-only customer timeline within the caller's store (exact phone/email). */
  @Roles(...STAFF)
  @Get('customers/profile')
  customerProfile(
    @CurrentUser() u: AuthUser,
    @Query('phone') phone?: string,
    @Query('email') email?: string,
  ) {
    return this.ops.customerProfile(this.scope(u), { phone, email });
  }

  /** Staff feedback on an AI reply (Conversation Studio teaching signal). Never auto-publishes. */
  @Roles(...STAFF)
  @Post('conversations/:id/reply-feedback')
  replyFeedback(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: ReplyFeedbackDto,
  ) {
    return this.ops.recordReplyFeedback(this.scope(u), u.sub, {
      conversationId: id,
      messageId: b.messageId,
      label: b.label,
      note: b.note,
    });
  }

  /** Conversation Studio + emergency AI controls for a rooftop. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get('locations/:id/ai-control')
  getAiControl(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const s = this.scope(u, undefined, id);
    return this.ops.getAiControl(s.tenantId, s.locationId ?? id);
  }

  /** Emergency kill switch — managers can stop the AI for their rooftop instantly. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('locations/:id/ai-control')
  aiControl(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: AiControlDto,
  ) {
    const s = this.scope(u, undefined, id);
    return this.ops.setAiControl(s.tenantId, s.locationId ?? id, u.sub, b);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Patch('locations/:id/settings')
  updateSettings(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: LocationOpsDto,
  ) {
    const s = this.scope(u, undefined, id);
    return this.ops.updateLocationSettings(
      s.tenantId,
      s.locationId ?? id,
      u.sub,
      b,
    );
  }

  // ── secure credit-application destination (no redeploy; URL is write-only)

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get('locations/:id/credit-application')
  creditStatus(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const s = this.scope(u, undefined, id);
    return this.creditAdmin.status(s.tenantId, s.locationId ?? id);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Put('locations/:id/credit-application/destination')
  creditConfigure(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: CreditDestinationDto,
  ) {
    const s = this.scope(u, undefined, id);
    return this.creditAdmin.configure(s.tenantId, s.locationId ?? id, u.sub, b);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post('locations/:id/credit-application/authorize')
  creditAuthorize(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: CreditAuthorizeDto,
  ) {
    const s = this.scope(u, undefined, id);
    return this.creditAdmin.authorize(s.tenantId, s.locationId ?? id, u.sub, b);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post('locations/:id/credit-application/disable')
  creditDisable(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const s = this.scope(u, undefined, id);
    return this.creditAdmin.disable(s.tenantId, s.locationId ?? id, u.sub);
  }
}

/** Widget-facing: staff replies / system events for the current (signed) conversation. */
@Controller('chat')
export class WidgetLiveController {
  constructor(
    private readonly ops: OperationsService,
    private readonly ids: ConversationIdService,
  ) {}

  @Get('live')
  live(
    @Req() req: { user?: { role?: string; tenantId?: string } },
    @Query('conversationId') conversationId: string,
    @Query('after') after?: string,
  ) {
    const user = req.user;
    if (user?.role !== 'widget' || !user.tenantId)
      throw new UnauthorizedException();
    if (!this.ids.verify(user.tenantId, conversationId))
      return { messages: [], aiPaused: false, handoffState: 'AI' };
    return this.ops.widgetMessagesSince(user.tenantId, conversationId, after);
  }
}
