import { Global, Module } from '@nestjs/common';
import { ConfigCacheService } from './config-cache.service';

@Global()
@Module({
  providers: [ConfigCacheService],
  exports: [ConfigCacheService],
})
export class CacheModule {}
