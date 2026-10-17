import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  IsEmail,
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
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { DocSigningService } from './doc-signing.service';

class SignRequestDto {
  @IsString() @MinLength(1) @MaxLength(256) documentRef!: string;
  @IsOptional() @IsString() @MaxLength(64) locationId?: string;
  @IsOptional() @IsEmail() @MaxLength(320) signerEmail?: string;
  @IsOptional() @IsString() @MaxLength(200) signerName?: string;
  @IsOptional() @IsString() @MaxLength(128) idempotencyKey?: string;
}

@Controller('documents')
@UseGuards(RolesGuard)
export class DocumentsController {
  constructor(private readonly docSigning: DocSigningService) {}

  /** Request an e-sign envelope (manager+); fail-closed without live e-sign provider. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('sign/request')
  requestSign(@CurrentUser() u: AuthUser, @Body() body: SignRequestDto) {
    assertStaffRole(u);
    const tenantId = resolveTenantId(u);
    const scopedLocation = resolveLocationScope(u, body.locationId);
    return this.docSigning.requestSign({
      tenantId,
      locationId: scopedLocation ?? body.locationId ?? null,
      documentRef: body.documentRef,
      signerEmail: body.signerEmail ?? null,
      signerName: body.signerName ?? null,
      idempotencyKey: body.idempotencyKey ?? null,
    });
  }
}
