import { Module } from '@nestjs/common';
import { PartsInquiryService } from './parts-inquiry.service';

@Module({
  providers: [PartsInquiryService],
  exports: [PartsInquiryService],
})
export class PartsModule {}
