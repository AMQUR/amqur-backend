import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import {
  AppointmentService,
  STAFF_APPOINTMENT_QUEUE_STATUSES,
} from './appointment.service';

describe('AppointmentService.notifyServiceAdvisor (via request)', () => {
  const createdRow = {
    id: 'appt-svc-1',
    tenantId: 'tenant-1',
    locationId: 'loc-1',
    conversationId: 'conv-1',
    type: 'SERVICE',
    status: AppointmentStatus.REQUESTED,
    requestedDate: '2026-10-20',
    requestedTime: '09:00',
    serviceType: 'oil change',
  };

  it('queues SERVICE_ADVISOR escalation for new service appointment requests', async () => {
    const prisma = {
      appointment: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
      },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
      escalation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'esc-1' }),
      },
      analyticsEvent: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (fn) =>
        fn({
          appointment: {
            create: jest.fn().mockResolvedValue(createdRow),
          },
          outboxEvent: { create: jest.fn().mockResolvedValue({}) },
        }),
      ),
    };
    const hours = {
      getProfile: jest.fn().mockResolvedValue({
        timezone: 'America/Chicago',
        verified: false,
      }),
    };
    const registry = { resolve: jest.fn().mockResolvedValue(null) };
    const now = new Date('2026-10-01T12:00:00.000Z');
    const svc = new AppointmentService(
      prisma as never,
      hours as never,
      registry as never,
      {} as never,
      { increment: jest.fn() } as never,
    );

    const res = await svc.request({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      type: 'SERVICE',
      when: {
        date: { year: 2026, month: 10, day: 20 },
        time: 9 * 60,
        phrase: 'Friday 9am',
      },
      serviceType: 'oil change',
      source: 'chat',
      now,
    });

    expect(res.status).toBe('saved');
    expect(prisma.escalation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reason: 'SERVICE_ADVISOR',
        conversationId: 'conv-1',
        metadata: expect.objectContaining({
          appointmentId: 'appt-svc-1',
          availabilityVerified: false,
        }),
      }),
    });
  });

  it('does not queue SERVICE_ADVISOR for sales appointments', async () => {
    const salesRow = { ...createdRow, id: 'appt-sales', type: 'SALES' };
    const prisma = {
      appointment: { findUnique: jest.fn().mockResolvedValue(null) },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
      escalation: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'esc-1' }),
      },
      analyticsEvent: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (fn) =>
        fn({
          appointment: { create: jest.fn().mockResolvedValue(salesRow) },
          outboxEvent: { create: jest.fn().mockResolvedValue({}) },
        }),
      ),
    };
    const hours = {
      getProfile: jest.fn().mockResolvedValue({
        timezone: 'America/Chicago',
        verified: false,
      }),
    };
    const registry = { resolve: jest.fn().mockResolvedValue(null) };
    const now = new Date('2026-10-01T12:00:00.000Z');
    const svc = new AppointmentService(
      prisma as never,
      hours as never,
      registry as never,
      {} as never,
      { increment: jest.fn() } as never,
    );

    await svc.request({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      type: 'SALES',
      when: {
        date: { year: 2026, month: 10, day: 20 },
        time: 10 * 60,
        phrase: 'visit',
      },
      source: 'chat',
      now,
    });

    expect(prisma.escalation.create).not.toHaveBeenCalled();
  });
});

describe('AppointmentService.updateStaff', () => {
  const prisma = {
    appointment: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    escalation: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  let svc: AppointmentService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new AppointmentService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    prisma.appointment.findFirst.mockResolvedValue({
      id: 'appt-1',
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      type: 'SERVICE',
      status: AppointmentStatus.REQUESTED,
      requestedAt: new Date('2026-10-17T15:00:00.000Z'),
    });
    prisma.appointment.update.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'appt-1',
        status: AppointmentStatus.REQUESTED,
        notes: data.notes ?? null,
      }),
    );
    jest.spyOn(svc, 'staffTransition').mockResolvedValue({
      id: 'appt-1',
      status: AppointmentStatus.CONFIRMED,
    } as never);
  });

  it('exports queue statuses without repair-order states', () => {
    expect(STAFF_APPOINTMENT_QUEUE_STATUSES).toEqual([
      AppointmentStatus.PENDING_CONFIRMATION,
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.CANCELLED,
      AppointmentStatus.COMPLETED,
    ]);
  });

  it('updates notes and writes audit log', async () => {
    const row = await svc.updateStaff('tenant-1', 'loc-1', 'appt-1', 'user-1', {
      notes: 'Called — waiting on advisor',
    });
    expect(row.notes).toBe('Called — waiting on advisor');
    expect(svc.staffTransition).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'appointment_request.update',
          resourceId: 'appt-1',
        }),
      }),
    );
  });

  it('uses staffTransition for allowed status changes', async () => {
    await svc.updateStaff('tenant-1', 'loc-1', 'appt-1', 'user-1', {
      status: AppointmentStatus.CONFIRMED,
      scheduledAt: '2026-10-17T15:00:00.000Z',
    });
    expect(svc.staffTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: 'appt-1',
        to: AppointmentStatus.CONFIRMED,
        actorId: 'user-1',
      }),
    );
  });

  it('allows COMPLETED via staffTransition', async () => {
    await svc.updateStaff('tenant-1', 'loc-1', 'appt-1', 'user-1', {
      status: AppointmentStatus.COMPLETED,
    });
    expect(svc.staffTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: 'appt-1',
        to: AppointmentStatus.COMPLETED,
        actorId: 'user-1',
      }),
    );
  });

  it('rejects disallowed status values', async () => {
    await expect(
      svc.updateStaff('tenant-1', 'loc-1', 'appt-1', 'user-1', {
        status: AppointmentStatus.NO_SHOW,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when appointment is out of scope', async () => {
    prisma.appointment.findFirst.mockResolvedValue(null);
    await expect(
      svc.updateStaff('tenant-1', 'loc-1', 'appt-missing', 'user-1', {
        notes: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('acknowledges matching SERVICE_ADVISOR escalation', async () => {
    prisma.escalation.findMany.mockResolvedValue([
      { id: 'esc-1', metadata: { appointmentId: 'appt-1' } },
    ]);
    await svc.updateStaff('tenant-1', 'loc-1', 'appt-1', 'user-1', {
      acknowledgeEscalation: true,
    });
    expect(prisma.escalation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['esc-1'] } },
      data: { status: 'ACKNOWLEDGED' },
    });
  });
});

describe('AppointmentService.staffTransition', () => {
  const prisma = {
    appointment: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    analyticsEvent: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    customerSurvey: {
      create: jest.fn().mockResolvedValue({ id: 'survey-1' }),
    },
  };
  const campaigns = { onEvent: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enrolls appointment reminder campaign on CONFIRMED', async () => {
    const scheduledAt = new Date('2026-10-17T15:00:00.000Z');
    prisma.appointment.findFirst.mockResolvedValue({
      id: 'appt-1',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      status: AppointmentStatus.REQUESTED,
      requestedAt: scheduledAt,
      provenance: {},
    });
    prisma.appointment.update.mockResolvedValue({
      id: 'appt-1',
      locationId: 'loc-1',
      scheduledAt,
    });
    const svc = new AppointmentService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      campaigns as never,
    );

    await svc.staffTransition({
      tenantId: 'tenant-1',
      appointmentId: 'appt-1',
      to: AppointmentStatus.CONFIRMED,
      actorId: 'user-1',
      scheduledAt: scheduledAt.toISOString(),
    });

    expect(campaigns.onEvent).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      trigger: 'appointment.confirmed.reminder',
      subjectId: 'appt-1',
      scheduledAt,
    });
  });

  it('creates internal SERVICE CSI draft when staff marks SERVICE COMPLETED', async () => {
    prisma.appointment.findFirst.mockResolvedValue({
      id: 'appt-svc-1',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      type: 'SERVICE',
      status: AppointmentStatus.CONFIRMED,
      leadId: 'lead-1',
      conversationId: 'conv-1',
      provenance: {},
    });
    prisma.appointment.update.mockResolvedValue({
      id: 'appt-svc-1',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      type: 'SERVICE',
      status: AppointmentStatus.COMPLETED,
    });
    const svc = new AppointmentService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await svc.staffTransition({
      tenantId: 'tenant-1',
      appointmentId: 'appt-svc-1',
      to: AppointmentStatus.COMPLETED,
      actorId: 'user-1',
    });

    expect(prisma.customerSurvey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        locationId: 'loc-1',
        leadId: 'lead-1',
        conversationId: 'conv-1',
        appointmentId: 'appt-svc-1',
        kind: 'SERVICE',
        status: 'DRAFT',
        channel: 'IN_PERSON',
        metadata: expect.objectContaining({
          trigger: 'service_appointment_completed',
        }),
      }),
    });
  });

  it('does not create CSI draft when SALES appointment is COMPLETED', async () => {
    prisma.appointment.findFirst.mockResolvedValue({
      id: 'appt-sales-1',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      type: 'SALES',
      status: AppointmentStatus.CONFIRMED,
      provenance: {},
    });
    prisma.appointment.update.mockResolvedValue({
      id: 'appt-sales-1',
      locationId: 'loc-1',
      type: 'SALES',
      status: AppointmentStatus.COMPLETED,
    });
    const svc = new AppointmentService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await svc.staffTransition({
      tenantId: 'tenant-1',
      appointmentId: 'appt-sales-1',
      to: AppointmentStatus.COMPLETED,
      actorId: 'user-1',
    });

    expect(prisma.customerSurvey.create).not.toHaveBeenCalled();
  });
});
