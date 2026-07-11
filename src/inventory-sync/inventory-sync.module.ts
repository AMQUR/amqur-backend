import { Module } from '@nestjs/common';
import { InventorySyncService } from './inventory-sync.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [IntegrationsModule, PrismaModule],
  providers: [InventorySyncService],
})
export class InventorySyncModule {}
