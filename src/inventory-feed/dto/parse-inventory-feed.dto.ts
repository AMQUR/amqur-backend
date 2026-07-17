import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ParseInventoryFeedDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url: string;

  @IsString()
  @IsIn(['XML', 'JSON', 'CSV'])
  type: 'XML' | 'JSON' | 'CSV';
}
