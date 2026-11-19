import { Global, Module } from '@nestjs/common';
import { AppointmentService } from './appointment.service';
import { AppointmentsController } from './appointments.controller';
import { SchedulingProviderRegistry } from './scheduling-provider.registry';
import { StoreHoursService } from '../locations/store-hours.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { SandboxSchedulerRegistrar } from './sandbox-scheduler.registrar';
import { AppointmentReconcileService } from './appointment-reconcile.service';

@Global()
@Module({
  imports: [IntegrationsModule],
  controllers: [AppointmentsController],
  providers: [
    AppointmentService,
    SchedulingProviderRegistry,
    StoreHoursService,
    SandboxSchedulerRegistrar,
    AppointmentReconcileService,
  ],
  exports: [AppointmentService, SchedulingProviderRegistry, StoreHoursService],
})
export class AppointmentsModule {}
