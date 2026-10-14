import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** Explicit, allowlisted host-page context — never scraped form data or cookies. */
export class PageContextDto {
  @IsOptional()
  @IsIn([
    'homepage',
    'inventory_search',
    'vdp',
    'specials',
    'finance',
    'service',
    'service_scheduler',
    'parts',
    'contact',
    'other',
  ])
  pageType?: string;
  @IsOptional() @IsString() @Length(11, 17) vin?: string;
  @IsOptional() @IsString() @MaxLength(20) stockNumber?: string;
  @IsOptional() @IsString() @MaxLength(80) utmSource?: string;
  @IsOptional() @IsString() @MaxLength(80) utmMedium?: string;
  @IsOptional() @IsString() @MaxLength(80) utmCampaign?: string;
  @IsOptional()
  @IsIn([
    'direct',
    'search',
    'social',
    'email',
    'paid',
    'referral',
    'internal',
    'unknown',
  ])
  referrerClass?: string;
}

export class ChatDto {
  // Structured widget actions (chips/cards) may omit text; free-text turns require it.
  @ValidateIf((o: ChatDto) => !o.action)
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  conversationId?: string;

  @IsOptional()
  @IsIn([
    'payment_estimate',
    'vehicle_detail',
    'hold_vehicle',
    'lead_capture',
    'finance',
    'credit_application',
    'test_drive',
    'trade',
    'compare',
    'service',
    'parts',
    'sales',
    'human',
    'hours',
  ])
  action?: string;

  @IsOptional()
  @IsString()
  @Length(11, 17)
  vin?: string;

  @IsOptional()
  @IsIn(['en', 'es'])
  language?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PageContextDto)
  pageContext?: PageContextDto;
}
