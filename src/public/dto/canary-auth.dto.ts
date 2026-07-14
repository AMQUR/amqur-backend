import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class IssueCanaryInviteDto {
  @IsString()
  @MinLength(1)
  tenantSlug!: string;

  @IsString()
  @MinLength(1)
  locationSlug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  testerLabel?: string;
}

export class RedeemCanaryInviteDto {
  @IsString()
  @MinLength(20)
  inviteToken!: string;
}

export class CanaryEligibilityDto {
  @IsString()
  @MinLength(1)
  tenantSlug!: string;

  @IsString()
  @MinLength(1)
  locationSlug!: string;
}

export class RevokeCanaryInviteDto {
  @IsString()
  @MinLength(8)
  jti!: string;
}
