import { Module } from '@nestjs/common';
import { VinDecoderService } from './vin-decoder.service';

@Module({
  providers: [VinDecoderService],
  exports: [VinDecoderService],
})
export class VinModule {}
