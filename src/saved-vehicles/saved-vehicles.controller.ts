import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SavedVehiclesService } from './saved-vehicles.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';

class SaveVehicleDto {
  @IsString()
  @Matches(/^[A-HJ-NPR-Z0-9]{17}$/i)
  vin!: string;

  @IsString()
  @Length(8, 128)
  conversationExternalKey!: string;

  @IsOptional()
  @IsBoolean()
  consentOutbound?: boolean;
}

@Controller('saved-vehicles')
@UseGuards(RolesGuard)
export class SavedVehiclesController {
  constructor(private readonly saved: SavedVehiclesService) {}

  @Roles('widget', 'STAFF', 'MANAGER', 'ADMIN', 'SUPER_ADMIN')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('conversationExternalKey') conversationExternalKey: string,
  ) {
    const tenantId = user.tenantId;
    if (!tenantId || !conversationExternalKey) {
      return { items: [] };
    }
    return this.saved
      .list({ tenantId, conversationExternalKey })
      .then((items) => ({ items }));
  }

  @Roles('widget', 'STAFF', 'MANAGER', 'ADMIN', 'SUPER_ADMIN')
  @Post()
  save(@CurrentUser() user: AuthUser, @Body() body: SaveVehicleDto) {
    if (!user.tenantId) return { ok: false, error: 'NO_TENANT' };
    return this.saved.save({
      tenantId: user.tenantId,
      locationId: user.locationId,
      conversationExternalKey: body.conversationExternalKey,
      vin: body.vin,
      consentOutbound: body.consentOutbound,
    });
  }

  @Roles('widget', 'STAFF', 'MANAGER', 'ADMIN', 'SUPER_ADMIN')
  @Delete()
  remove(
    @CurrentUser() user: AuthUser,
    @Query('vin') vin: string,
    @Query('conversationExternalKey') conversationExternalKey: string,
  ) {
    if (!user.tenantId) return { ok: false };
    return this.saved.remove({
      tenantId: user.tenantId,
      conversationExternalKey,
      vin,
    });
  }
}
