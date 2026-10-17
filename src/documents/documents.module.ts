import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocSigningService } from './doc-signing.service';

@Module({
  controllers: [DocumentsController],
  providers: [DocSigningService],
  exports: [DocSigningService],
})
export class DocumentsModule {}
