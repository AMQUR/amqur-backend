import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PlaybookDepartment } from '@prisma/client';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { PlaybookService } from './playbook.service';

class ExampleDto {
  @IsString() @MinLength(1) @MaxLength(800) good!: string;
  @IsString() @MinLength(1) @MaxLength(800) bad!: string;
  @IsOptional() @IsString() @MaxLength(400) note?: string;
}

class PlaybookDto {
  @IsString() @MinLength(2) @MaxLength(80) key!: string;
  @IsString() @MinLength(2) @MaxLength(160) title!: string;
  @IsOptional()
  @IsIn(['GENERAL', 'SALES', 'SERVICE', 'PARTS', 'FINANCE'])
  department?: PlaybookDepartment;
  @IsOptional()
  @IsIn(['casual', 'professional', 'concise', 'friendly', 'premium'])
  tone?: string;
  @IsOptional() @IsIn(['short', 'standard', 'detailed']) brevity?: string;
  @IsOptional() @IsBoolean() allowRapport?: boolean;
  @IsOptional() @IsBoolean() oneQuestion?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  approvedPhrases?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  forbiddenPhrases?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ExampleDto)
  examples?: ExampleDto[];
  @IsOptional() @IsString() @MaxLength(4000) coachingNotes?: string;
}

class PreviewDto {
  @IsString() @MinLength(1) @MaxLength(2000) candidate!: string;
}

@Controller('ops/playbooks')
@UseGuards(RolesGuard)
export class PlaybooksController {
  constructor(private readonly playbooks: PlaybookService) {}

  private tenant(u: AuthUser) {
    return resolveTenantId(u);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get()
  list(
    @CurrentUser() u: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    const loc = resolveLocationScope(u, locationId);
    return this.playbooks.list(this.tenant(u), loc);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.playbooks.get(this.tenant(u), id);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post()
  create(
    @CurrentUser() u: AuthUser,
    @Query('locationId') locationId: string | undefined,
    @Body() b: PlaybookDto,
  ) {
    const loc = resolveLocationScope(u, locationId);
    return this.playbooks.create(this.tenant(u), u.sub, loc, b);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: Partial<PlaybookDto>,
  ) {
    return this.playbooks.updateDraft(this.tenant(u), u.sub, id, b);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post(':id/submit')
  submit(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.playbooks.submitForReview(this.tenant(u), u.sub, id);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post(':id/approve')
  approve(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.playbooks.approve(this.tenant(u), u.sub, id);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post(':id/publish')
  publish(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.playbooks.publish(this.tenant(u), u.sub, id);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post(':id/rollback')
  rollback(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.playbooks.rollback(this.tenant(u), u.sub, id);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post(':id/preview')
  async preview(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: PreviewDto,
  ) {
    const pb = await this.playbooks.get(this.tenant(u), id);
    return this.playbooks.previewStyle(pb, b.candidate);
  }
}
