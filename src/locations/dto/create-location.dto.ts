import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';
import { InventoryFeedType } from '@prisma/client';

export class CreateLocationDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Matches(/^[a-z0-9-]+$/i, {
    message: 'slug must be alphanumeric with dashes only',
  })
  slug: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  inventoryFeedUrl?: string;

  @IsOptional()
  @IsEnum(InventoryFeedType)
  inventoryFeedType?: InventoryFeedType;
}
