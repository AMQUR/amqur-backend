import { LeadAppointmentUpdate, OutboxStatus } from '@prisma/client';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { MetricsService } from '../../observability/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxProcessorService } from '../core/outbox-processor.service';
import { OUTBOX_MAX_ATTEMPTS, OutboxService } from '../core/outbox.service';
import { LeadDeliveryRouteService } from './lead-delivery-route.service';
import { LeadDeliveryService } from './lead-delivery.service';
import {
  LEAD_APPOINTMENT_UPDATE_TOPIC,
  LeadAppointmentUpdateService,
  stableAppointmentUpdateMessageId,
} from './lead-appointment-update.service';
import { SandboxSinkTransport } from './transports/sandbox-sink.transport';
import { SmtpLeadTransport } from './transports/smtp.transport';

describe('stableAppointmentUpdateMessageId', () => {
  it('builds a durable id from the update row and from-address domain', () => {
    expect(
      stableAppointmentUpdateMessageId(
        'update-1',
        'leads@relay.amqur.example.invalid',
      ),
    ).toBe('<lead-appointment-update.update-1@relay.amqur.example.invalid>');
  });

  it('falls back when from-address has no domain', () => {
    expect(stableAppointmentUpdateMessageId('u', 'noreply@')).toBe(
      '<lead-appointment-update.u@amqur.example.invalid>',
    );
  });
});

describe('R8 appointment update abandonment', () => {
  const key = { id: 'update', tenantId: 'tenant', outboxEventId: 'outbox' };
  const queued = {
    ...key,
    status: 'QUEUED',
    lastErrorCode: null,
    leadDeliveryId: 'delivery',
    appointmentId: 'appointment',
    state: 'CONFIRMED',
  } as LeadAppointmentUpdate;

  function setup() {
    let row = { ...queued };
    const updates = {
      findFirst: jest.fn(async () => row as LeadAppointmentUpdate | null),
      updateMany: jest.fn(
        async ({ data }: { data: Partial<LeadAppointmentUpdate> }) => {
          row = { ...row, ...data };
          return { count: 1 };
        },
      ),
    };
    const prisma = {
      leadAppointmentUpdate: updates,
      leadDelivery: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([key]),
    };
    const outbox = {
      claimPending: jest.fn().mockResolvedValue([
        {
          id: key.outboxEventId,
          tenantId: key.tenantId,
          topic: LEAD_APPOINTMENT_UPDATE_TOPIC,
          payload: { updateId: key.id },
          status: OutboxStatus.PROCESSING,
          attempts: OUTBOX_MAX_ATTEMPTS,
        },
      ]),
      beginHandling: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const metrics = { increment: jest.fn() } as unknown as MetricsService;
    const processor = new OutboxProcessorService(
      outbox as unknown as OutboxService,
      prisma as unknown as PrismaService,
      metrics,
    );
    const sink = { send: jest.fn() };
    const smtp = { send: jest.fn() };
    const service = new LeadAppointmentUpdateService(
      prisma as unknown as PrismaService,
      outbox as unknown as OutboxService,
      processor,
      {} as FeatureFlagsService,
      {} as LeadDeliveryRouteService,
      { onAccepted: jest.fn() } as unknown as LeadDeliveryService,
      metrics,
      sink as unknown as SandboxSinkTransport,
      smtp as unknown as SmtpLeadTransport,
    );
    service.onModuleInit();
    return { service, processor, outbox, prisma, updates, sink, smtp };
  }

  it.each(['QUEUED', 'SENT', 'FAILED'] as const)(
    'settles an abandoned %s update after the processor dead-letters its job',
    async (status) => {
      const { service, processor, outbox, updates, sink, smtp } = setup();
      updates.findFirst.mockResolvedValueOnce({ ...queued, status });
      const handler = jest.spyOn(service, 'process');

      await expect(processor.processBatch(1, 'worker')).resolves.toBe(0);
      expect(outbox.markFailed).toHaveBeenCalledWith(
        key.outboxEventId,
        'abandoned_after_repeated_lease_expiry',
        OUTBOX_MAX_ATTEMPTS,
        { workerId: 'worker', permanent: true },
      );
      expect(updates.findFirst).toHaveBeenCalledWith({
        where: { ...key, status: { in: ['QUEUED', 'SENT', 'FAILED'] } },
      });
      expect(updates.updateMany).toHaveBeenCalledWith({
        where: { ...key, status, lastErrorCode: null },
        data: expect.objectContaining({
          status: 'DEAD',
          lastErrorCode: 'outbox_abandoned',
          deadAt: expect.any(Date),
        }),
      });
      expect(handler).not.toHaveBeenCalled();
      expect(sink.send).not.toHaveBeenCalled();
      expect(smtp.send).not.toHaveBeenCalled();
    },
  );

  it('finalizes a persisted SMTP receipt without resending', async () => {
    const { processor, updates, sink, smtp } = setup();
    const acceptedAt = new Date('2026-11-19T00:00:00Z');
    updates.findFirst.mockResolvedValueOnce({
      ...queued,
      status: 'SENT',
      lastErrorCode: 'accepted_record_pending',
      providerName: 'smtp',
      providerMessageId: 'message',
      providerRawStatus: '250',
      acceptedAt,
    });

    await processor.processBatch(1, 'worker');
    expect(updates.updateMany).toHaveBeenCalledTimes(1);
    expect(updates.updateMany).toHaveBeenCalledWith({
      where: { id: key.id, tenantId: key.tenantId, status: 'SENT' },
      data: expect.objectContaining({
        status: 'ACCEPTED',
        lastErrorCode: null,
        providerMessageId: 'message',
        acceptedAt,
      }),
    });
    expect(sink.send).not.toHaveBeenCalled();
    expect(smtp.send).not.toHaveBeenCalled();
  });

  it('recovers after a hook failure with a bounded sweep and leaves terminal rows alone', async () => {
    const { service, processor, prisma, updates } = setup();
    updates.findFirst.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(processor.processBatch(1, 'worker')).resolves.toBe(0);
    expect(updates.updateMany).not.toHaveBeenCalled();
    await expect(service.sweepBehindDeadOutbox(900)).resolves.toBe(1);
    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ values: ['QUEUED', 'SENT', 'FAILED'] }),
      LEAD_APPOINTMENT_UPDATE_TOPIC,
      500,
    );
    updates.findFirst.mockResolvedValueOnce(null);
    await expect(service.sweepBehindDeadOutbox()).resolves.toBe(0);
    expect(updates.updateMany).toHaveBeenCalledTimes(1);
  });
});
