import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrivacyService } from './privacy.service';

class SubjectDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
}

/** Admin-only privacy request handling (access/export, deletion). All actions audited. */
@Controller('privacy')
@UseGuards(RolesGuard)
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post('export')
  export(@CurrentUser() u: AuthUser, @Body() b: SubjectDto) {
    assertStaffRole(u);
    return this.privacy.export(u.tenantId, u.sub, b);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post('delete')
  remove(@CurrentUser() u: AuthUser, @Body() b: SubjectDto) {
    assertStaffRole(u);
    return this.privacy.pseudonymize(u.tenantId, u.sub, b);
  }
}
