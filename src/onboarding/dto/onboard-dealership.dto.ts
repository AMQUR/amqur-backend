import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class BrandingDto {
  @IsOptional() @IsString() assistantDisplayName?: string;
  @IsOptional() @IsString() welcomeMessage?: string;
  @IsOptional() @IsString() primaryColor?: string;
  @IsOptional() @IsString() accentColor?: string;
  @IsOptional() @IsString() logoUrl?: string;
  @IsOptional() @IsString() launcherIconUrl?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() websiteUrl?: string;
  @IsOptional() @IsString() privacyUrl?: string;
  @IsOptional() @IsString() termsUrl?: string;
  @IsOptional() @IsString() escalationMessage?: string;
  @IsOptional() @IsString() disclaimerText?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) supportedLocales?: string[];
  @IsOptional() @IsBoolean() salesEnabled?: boolean;
  @IsOptional() @IsBoolean() serviceEnabled?: boolean;
  @IsOptional() @IsBoolean() partsEnabled?: boolean;
}

class AdminUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(10) password!: string;
  @IsString() firstName!: string;
  @IsString() lastName!: string;
}

export class OnboardDealershipDto {
  @IsOptional() @IsString() dealerGroupName?: string;
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]+$/)
  dealerGroupSlug?: string;

  @IsString() tenantName!: string;
  @IsString()
  @Matches(/^[a-z0-9-]+$/)
  tenantSlug!: string;

  @IsString() locationName!: string;
  @IsString()
  @Matches(/^[a-z0-9-]+$/)
  locationSlug!: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  allowedOrigins?: string[];

  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsObject() storeHours?: Record<string, unknown>;

  @IsOptional() @ValidateNested() @Type(() => BrandingDto)
  branding?: BrandingDto;

  @IsOptional() @IsObject() featureFlags?: Record<string, boolean>;

  @IsOptional() @IsString() inventoryFeedUrl?: string;
  @IsOptional() @IsString() inventoryFeedType?: 'XML' | 'JSON' | 'CSV';

  @IsOptional() @IsArray() @IsEmail({}, { each: true })
  escalationRecipients?: string[];

  @IsOptional() @IsInt() @Min(30) @Max(3650)
  dataRetentionDays?: number;

  @IsOptional() @IsString() consentText?: string;

  @IsOptional() @ValidateNested() @Type(() => AdminUserDto)
  adminUser?: AdminUserDto;

  /** When true, re-run updates existing tenant/location without duplicating. */
  @IsOptional() @IsBoolean() idempotent?: boolean;
}
