import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Matches(/^[a-z0-9-]+$/i, {
    message: 'slug must be alphanumeric with dashes only',
  })
  slug: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;
}
