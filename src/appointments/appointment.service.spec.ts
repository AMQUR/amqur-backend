import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import {
  AppointmentService,
  STAFF_APPOINTMENT_QUEUE_STATUSES,
} from './appointment.service';

describe('AppointmentService.updateStaff', () => {
  const prisma = {
    appointment: {
      findFirst: jest.fn(),
      update: jest.fn(),
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

  it('rejects disallowed status values', async () => {
    await expect(
      svc.updateStaff('tenant-1', 'loc-1', 'appt-1', 'user-1', {
        status: AppointmentStatus.COMPLETED,
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
});
