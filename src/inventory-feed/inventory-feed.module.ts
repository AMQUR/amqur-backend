import { Module } from '@nestjs/common';
import { InventoryFeedController } from './inventory-feed.controller';
import { InventoryFeedService } from './inventory-feed.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [InventoryFeedController],
  providers: [InventoryFeedService],
  exports: [InventoryFeedService],
})
export class InventoryFeedModule {}
