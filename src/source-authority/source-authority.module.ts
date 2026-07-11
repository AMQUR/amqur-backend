import { Global, Module } from '@nestjs/common';
import { SourceAuthorityService } from './source-authority.service';

@Global()
@Module({
  providers: [SourceAuthorityService],
  exports: [SourceAuthorityService],
})
export class SourceAuthorityModule {}
