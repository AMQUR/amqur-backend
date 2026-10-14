import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { SavedVehiclesService } from './saved-vehicles.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { ConversationIdService } from '../chat/conversation-id.service';
import { CapabilityService } from '../capability/capability.service';

class SaveVehicleDto {
  @IsString()
  @Matches(/^[A-HJ-NPR-Z0-9]{17}$/i)
  vin!: string;

  /** Server-issued signed conversation id (widget) — never an arbitrary client key. */
  @IsString()
  @Length(8, 128)
  conversationId!: string;

  @IsOptional()
  @IsBoolean()
  consentOutbound?: boolean;
}

/**
 * Saved vehicles are bound to the visitor's signed conversation. A widget token can only
 * read/write the conversation it was issued, preventing cross-visitor enumeration.
 * Alerts (price drop / back in stock) are consent-specific and only fire from verified
 * inventory changes (see follow-up engine).
 */
@Controller('saved-vehicles')
@UseGuards(RolesGuard)
export class SavedVehiclesController {
  constructor(
    private readonly saved: SavedVehiclesService,
    private readonly ids: ConversationIdService,
    private readonly caps: CapabilityService,
  ) {}

  private async key(user: AuthUser, conversationId?: string): Promise<string> {
    if (!conversationId)
      throw new BadRequestException('conversationId required');
    if (user.role === 'widget') {
      if (!this.ids.verify(user.tenantId, conversationId))
        throw new ForbiddenException('Invalid conversation');
      const cap = await this.caps.check(
        user.tenantId,
        user.locationId,
        'savedVehicles',
      );
      if (!cap.allowed)
        throw new ForbiddenException(cap.reason ?? 'saved_vehicles_disabled');
    }
    return conversationId;
  }

  @Roles('widget', 'STAFF', 'MANAGER', 'ADMIN', 'SUPER_ADMIN')
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('conversationId') conversationId: string,
  ) {
    const k = await this.key(user, conversationId);
    return this.saved.list({
      tenantId: user.tenantId,
      conversationExternalKey: k,
    });
  }

  @Roles('widget', 'STAFF', 'MANAGER', 'ADMIN', 'SUPER_ADMIN')
  @Post()
  async save(@CurrentUser() user: AuthUser, @Body() body: SaveVehicleDto) {
    const k = await this.key(user, body.conversationId);
    return this.saved.save({
      tenantId: user.tenantId,
      locationId: user.locationId,
      conversationExternalKey: k,
      vin: body.vin,
      consentOutbound: body.consentOutbound,
    });
  }

  @Roles('widget', 'STAFF', 'MANAGER', 'ADMIN', 'SUPER_ADMIN')
  @Delete()
  async remove(@CurrentUser() user: AuthUser, @Body() body: SaveVehicleDto) {
    const k = await this.key(user, body.conversationId);
    return this.saved.remove({
      tenantId: user.tenantId,
      conversationExternalKey: k,
      vin: body.vin,
    });
  }
}
