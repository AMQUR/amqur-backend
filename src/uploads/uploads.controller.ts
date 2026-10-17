import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { FilePurpose } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  resolveTenantId,
  assertStaffRole,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { UploadsService } from './uploads.service';

class UploadMetaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  originalName!: string;

  @IsString()
  mimeType!: string;

  /** Legacy base64 payload (small files). Prefer multipart POST /uploads/file. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  contentBase64?: string;

  @IsIn(Object.values(FilePurpose))
  purpose!: FilePurpose;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsString()
  conversationId?: string;
}

@Controller('uploads')
@UseGuards(RolesGuard)
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly flags: FeatureFlagsService,
  ) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post()
  async upload(@CurrentUser() user: AuthUser, @Body() dto: UploadMetaDto) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const resolved = await this.flags.resolve(tenantId, user.locationId);
    if (resolved.uploads !== true) {
      throw new BadRequestException('Uploads are disabled for this tenant');
    }
    if (!dto.contentBase64)
      throw new BadRequestException(
        'contentBase64 required (or use /uploads/file)',
      );
    const buffer = Buffer.from(dto.contentBase64, 'base64');
    return this.uploads.upload({
      tenantId,
      locationId: user.locationId ?? dto.locationId ?? null,
      originalName: dto.originalName,
      mimeType: dto.mimeType,
      buffer,
      purpose: dto.purpose,
      uploadedByUserId: user.sub,
      conversationId: dto.conversationId ?? null,
    });
  }

  /** Streaming multipart upload (field "file"), 10 MB cap enforced by multer before buffering more. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post('file')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  async uploadFile(
    @CurrentUser() user: AuthUser,
    @UploadedFile()
    file:
      | { buffer: Buffer; originalname: string; mimetype: string }
      | undefined,
    @Body('purpose') purpose: FilePurpose,
    @Body('conversationId') conversationId?: string,
  ) {
    assertStaffRole(user);
    if (!file) throw new BadRequestException('file required');
    if (!Object.values(FilePurpose).includes(purpose))
      throw new BadRequestException('invalid purpose');
    const resolved = await this.flags.resolve(user.tenantId, user.locationId);
    if (resolved.uploads !== true)
      throw new BadRequestException('Uploads are disabled for this tenant');
    const row = await this.uploads.upload({
      tenantId: user.tenantId,
      locationId: user.locationId ?? null,
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      purpose,
      uploadedByUserId: user.sub,
      conversationId: conversationId ?? null,
    });
    return {
      ...row,
      downloadPath: this.uploads.signedPath(user.tenantId, row.id),
    };
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get(':id/link')
  link(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    assertStaffRole(user);
    return { downloadPath: this.uploads.signedPath(user.tenantId, id) };
  }

  @Public()
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @Query() q: { t: string; e: string; s: string },
    @Res() res: Response,
  ) {
    const { file, buf, quarantined } = await this.uploads.readForDownload(
      id,
      q,
    );
    res.setHeader(
      'Content-Type',
      quarantined ? 'application/octet-stream' : file.mimeType,
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.originalName.replace(/"/g, '')}"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (quarantined) res.setHeader('X-AMQUR-Scan-Status', file.scannedStatus);
    res.send(buf);
  }
}
