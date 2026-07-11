import { IsEmail, IsString, MinLength } from 'class-validator';

export class BootstrapDto {
  @IsString()
  @MinLength(16)
  secret: string;

  @IsString()
  @MinLength(2)
  tenantName: string;

  @IsString()
  @MinLength(2)
  tenantSlug: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @MinLength(1)
  firstName: string;

  @IsString()
  @MinLength(1)
  lastName: string;
}
