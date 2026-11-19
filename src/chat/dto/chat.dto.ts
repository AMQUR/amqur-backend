import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  registerDecorator,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

export const CONTACT_CHANNELS = ['EMAIL', 'CALL', 'TEXT'] as const;
export const APPOINTMENT_WINDOWS = ['morning', 'afternoon', 'evening'] as const;

/** A structured payload is only valid together with its own action. */
function OnlyWithAction(action: string, options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'onlyWithAction',
      target: object.constructor,
      propertyName,
      constraints: [action],
      options: {
        message: `${propertyName} is only allowed with action "${action}"`,
        ...options,
      },
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          return (
            value === undefined ||
            value === null ||
            (args.object as { action?: string }).action === args.constraints[0]
          );
        },
      },
    });
}

export class LeadConsentDto {
  @IsIn(CONTACT_CHANNELS) channel: (typeof CONTACT_CHANNELS)[number];
  @IsBoolean() granted: boolean;
  @IsString() @Length(1, 64) version: string;
}

/**
 * Structured lead-form submission. Contact fields only — anything else (SSN, date of birth,
 * income, bank details…) is rejected by the whitelist before it reaches the engine.
 */
export class LeadSubmissionDto {
  @IsString() @Matches(/^lf_[A-Za-z0-9_-]{8,48}$/) formId: string;
  @IsString() @Length(1, 60) firstName: string;
  @IsString() @Length(1, 60) lastName: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @Length(7, 24) phone?: string;
  @IsIn(CONTACT_CHANNELS) preferredChannel: (typeof CONTACT_CHANNELS)[number];
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique((c: LeadConsentDto) => c?.channel)
  @ValidateNested({ each: true })
  @Type(() => LeadConsentDto)
  consents: LeadConsentDto[];
}

export class AppointmentSelectionDto {
  @IsString() @Matches(/^pk_[A-Za-z0-9_-]{8,48}$/) pickerId: string;
  @IsOptional()
  @IsString()
  @Matches(/^sl_[A-Za-z0-9_-]{8,48}$/)
  slotId?: string;
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  requestedDate?: string;
  @IsOptional()
  @IsIn(APPOINTMENT_WINDOWS)
  requestedWindow?: (typeof APPOINTMENT_WINDOWS)[number];
}

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
    'appointment_select',
  ])
  action?: string;

  @IsOptional()
  @IsString()
  @Length(11, 17)
  vin?: string;

  /**
   * Opaque rooftop reference from a group-site vehicle card, echoed back with its VIN. Only
   * its shape is checked here; it is verified server-side and ignored outside a group site.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  rooftopRef?: string;

  @IsOptional()
  @IsIn(['en', 'es'])
  language?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PageContextDto)
  pageContext?: PageContextDto;

  /** Lead-form submission — only with action "lead_capture". */
  @IsOptional()
  @OnlyWithAction('lead_capture')
  @IsObject()
  @ValidateNested()
  @Type(() => LeadSubmissionDto)
  lead?: LeadSubmissionDto;

  /** Appointment-picker choice — only with action "appointment_select". */
  @IsOptional()
  @OnlyWithAction('appointment_select')
  @IsObject()
  @ValidateNested()
  @Type(() => AppointmentSelectionDto)
  appointment?: AppointmentSelectionDto;
}
