import { Global, Module } from '@nestjs/common';
import { AppointmentService } from './appointment.service';
import { AppointmentsController } from './appointments.controller';
import { SchedulingProviderRegistry } from './scheduling-provider.registry';
import { StoreHoursService } from '../locations/store-hours.service';
import { IntegrationsModule } from '../integrations/integrations.module';

@Global()
@Module({
  imports: [IntegrationsModule],
  controllers: [AppointmentsController],
  providers: [
    AppointmentService,
    SchedulingProviderRegistry,
    StoreHoursService,
  ],
  exports: [AppointmentService, SchedulingProviderRegistry, StoreHoursService],
})
export class AppointmentsModule {}
