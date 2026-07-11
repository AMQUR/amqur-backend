import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  /** Optional tenant slug when email exists across tenants */
  @IsOptional()
  @IsString()
  tenantSlug?: string;
}
