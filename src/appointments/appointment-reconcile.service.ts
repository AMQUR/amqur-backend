import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  OutboxHandlerResult,
  OutboxProcessorService,
  PermanentOutboxError,
} from '../integrations/core/outbox-processor.service';
import {
  APPOINTMENT_RECONCILE_TOPIC,
  AppointmentService,
} from './appointment.service';

/**
 * Outbox worker for `appointment.provider.reconcile`: the compensation job queued whenever a
 * scheduler create() outcome is unknown. All logic lives in
 * AppointmentService.reconcileProviderBooking; this class only wires it to the durable outbox
 * (at-least-once, backoff, DEAD after the attempt limit — visible in the ops outbox).
 */
@Injectable()
export class AppointmentReconcileService implements OnModuleInit {
  private readonly logger = new Logger(AppointmentReconcileService.name);

  constructor(
    private readonly processor: OutboxProcessorService,
    private readonly appointments: AppointmentService,
  ) {}

  onModuleInit(): void {
    this.processor.registerHandler(APPOINTMENT_RECONCILE_TOPIC, (p, m) =>
      this.handle(p, m),
    );
  }

  async handle(
    p: Record<string, unknown>,
    meta: { tenantId: string },
  ): Promise<OutboxHandlerResult> {
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const appointmentId = str(p.appointmentId);
    const provider = str(p.provider);
    const connectionId = str(p.connectionId);
    const bookingIdempotencyKey = str(p.bookingIdempotencyKey);
    if (!appointmentId || !provider || !connectionId || !bookingIdempotencyKey)
      throw new PermanentOutboxError('bad_payload');
    const result = await this.appointments.reconcileProviderBooking({
      tenantId: meta.tenantId,
      appointmentId,
      provider,
      connectionId,
      mode: p.mode === 'production' ? 'production' : 'sandbox',
      bookingIdempotencyKey,
      locationId: str(p.locationId),
    });
    if (result === 'adapter_cannot_reconcile') {
      // Dead-lettered on purpose: staff must reconcile this booking by hand.
      this.logger.error(
        `appointment ${appointmentId}: provider ${provider} cannot be reconciled by idempotency key`,
      );
      throw new PermanentOutboxError('adapter_cannot_reconcile');
    }
    return { note: result };
  }
}
