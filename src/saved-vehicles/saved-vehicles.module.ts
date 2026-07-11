import { Module } from '@nestjs/common';
import { SavedVehiclesService } from './saved-vehicles.service';
import { SavedVehiclesController } from './saved-vehicles.controller';

@Module({
  controllers: [SavedVehiclesController],
  providers: [SavedVehiclesService],
  exports: [SavedVehiclesService],
})
export class SavedVehiclesModule {}
