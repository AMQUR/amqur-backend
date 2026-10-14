import { Module } from '@nestjs/common';
import { SavedVehiclesService } from './saved-vehicles.service';
import { SavedVehiclesController } from './saved-vehicles.controller';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [ChatModule],
  controllers: [SavedVehiclesController],
  providers: [SavedVehiclesService],
  exports: [SavedVehiclesService],
})
export class SavedVehiclesModule {}
