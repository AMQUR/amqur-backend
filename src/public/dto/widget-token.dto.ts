import { IsString } from 'class-validator';

export class WidgetTokenDto {
  @IsString()
  tenantSlug: string;

  @IsString()
  locationSlug: string;
}
