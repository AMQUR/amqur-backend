import { Prisma } from '@prisma/client';
import { fromZoned, toZoned } from '../common/time/zoned-time';
import { MessagingService } from './messaging.service';

const defaultQuiet = {
  tz: 'America/Chicago',
  start: 21 * 60,
  end: 8 * 60,
};

function localInstant(
  tz: string,
  parts: { year: number; month: number; day: number; hour: number; minute: number },
): Date {
  return fromZoned(parts, tz);
}

describe('MessagingService.nextAllowed DST quiet hours', () => {
  it('defers spring-forward night (America/Chicago) to 08:00 local, not during quiet', () => {
    const now = localInstant('America/Chicago', {
      year: 2026,
      month: 3,
      day: 8,
      hour: 22,
      minute: 30,
    });
    const deferred = MessagingService.nextAllowed(now, defaultQuiet);
    expect(deferred).not.toBeNull();
    expect(deferred!.toISOString()).toBe('2026-03-09T13:00:00.000Z');
    const endLocal = toZoned(deferred!, 'America/Chicago');
    expect(endLocal).toMatchObject({ year: 2026, month: 3, day: 9, hour: 8, minute: 0 });
    expect(MessagingService.nextAllowed(deferred!, defaultQuiet)).toBeNull();
  });

  it('defers fall-back early morning (America/Chicago) to same-day 08:00 local', () => {
    const now = localInstant('America/Chicago', {
      year: 2026,
      month: 11,
      day: 1,
      hour: 7,
      minute: 30,
    });
    const deferred = MessagingService.nextAllowed(now, defaultQuiet);
    expect(deferred).not.toBeNull();
    expect(deferred!.toISOString()).toBe('2026-11-01T14:00:00.000Z');
    const endLocal = toZoned(deferred!, 'America/Chicago');
    expect(endLocal).toMatchObject({ year: 2026, month: 11, day: 1, hour: 8, minute: 0 });
    expect(MessagingService.nextAllowed(deferred!, defaultQuiet)).toBeNull();
  });

  it('allows send midday on US spring-forward transition day (America/Chicago)', () => {
    const now = localInstant('America/Chicago', {
      year: 2026,
      month: 3,
      day: 8,
      hour: 9,
      minute: 0,
    });
    expect(MessagingService.nextAllowed(now, defaultQuiet)).toBeNull();
  });

  it('defers spring-forward and fall-back boundaries in America/New_York', () => {
    const nyQuiet = { tz: 'America/New_York', start: 21 * 60, end: 8 * 60 };
    const springNight = localInstant('America/New_York', {
      year: 2026,
      month: 3,
      day: 8,
      hour: 22,
      minute: 30,
    });
    const springDeferred = MessagingService.nextAllowed(springNight, nyQuiet);
    expect(springDeferred!.toISOString()).toBe('2026-03-09T12:00:00.000Z');
    expect(toZoned(springDeferred!, nyQuiet.tz)).toMatchObject({
      year: 2026,
      month: 3,
      day: 9,
      hour: 8,
      minute: 0,
    });

    const fallEarly = localInstant('America/New_York', {
      year: 2026,
      month: 11,
      day: 1,
      hour: 7,
      minute: 30,
    });
    const fallDeferred = MessagingService.nextAllowed(fallEarly, nyQuiet);
    expect(fallDeferred!.toISOString()).toBe('2026-11-01T13:00:00.000Z');
    expect(toZoned(fallDeferred!, nyQuiet.tz)).toMatchObject({
      year: 2026,
      month: 11,
      day: 1,
      hour: 8,
      minute: 0,
    });
    expect(MessagingService.nextAllowed(fallDeferred!, nyQuiet)).toBeNull();
  });
});

describe('MessagingService.queue idempotency', () => {
  const queuedRow = { id: 'msg-1', status: 'QUEUED' as const };
  const tx = {
    outboundMessage: {
      create: jest.fn().mockResolvedValue(queuedRow),
    },
  };
  const prisma = {
    outboundMessage: {
      findUnique: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
    },
    integrationConnection: { findFirst: jest.fn() },
    location: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) =>
      fn(tx),
    ),
  };
  const vault = { isReady: jest.fn().mockReturnValue(true), decrypt: jest.fn() };
  const outbox = { enqueue: jest.fn().mockResolvedValue({ id: 'ob-1' }) };
  const processor = { registerHandler: jest.fn() };
  const flags = { resolve: jest.fn().mockResolvedValue({ sms: true }) };
  const consent = {
    status: jest.fn().mockResolvedValue({ allowed: true }),
  };
  const metrics = { increment: jest.fn() };

  const svc = new MessagingService(
    prisma as never,
    vault as never,
    outbox as never,
    processor as never,
    flags as never,
    consent as never,
    metrics as never,
  );

  const baseQueue = {
    tenantId: 'tenant-1',
    channel: 'SMS' as const,
    to: '+15551234567',
    body: 'Hello',
    purpose: 'CONVERSATIONAL' as const,
    idempotencyKey: 'idem-key-1',
    /** Tue 10:00 America/Chicago — outside default quiet hours */
    now: new Date('2026-10-13T15:00:00Z'),
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.outboundMessage.findUnique.mockResolvedValue(null);
    prisma.outboundMessage.count.mockResolvedValue(0);
    prisma.integrationConnection.findFirst.mockResolvedValue({
      secrets: [
        { keyName: 'accountSid', ciphertext: 'x' },
        { keyName: 'authToken', ciphertext: 'x' },
        { keyName: 'messagingServiceSid', ciphertext: 'x' },
      ],
    });
    vault.isReady.mockReturnValue(true);
    vault.decrypt.mockReturnValue('secret');
    flags.resolve.mockResolvedValue({ sms: true });
    consent.status.mockResolvedValue({ allowed: true });
    tx.outboundMessage.create.mockResolvedValue(queuedRow);
    prisma.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) =>
      fn(tx),
    );
  });

  it('does not create a second QUEUED send for the same idempotencyKey', async () => {
    prisma.outboundMessage.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(queuedRow);

    const first = await svc.queue(baseQueue);
    const second = await svc.queue(baseQueue);

    expect(first).toEqual({ status: 'QUEUED', id: 'msg-1' });
    expect(second).toEqual({ status: 'QUEUED', id: 'msg-1' });
    expect(tx.outboundMessage.create).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
  });

  it('returns the winner row on concurrent duplicate insert (P2002)', async () => {
    const err = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    tx.outboundMessage.create.mockRejectedValue(err);
    prisma.outboundMessage.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(queuedRow);

    const result = await svc.queue(baseQueue);

    expect(result).toEqual({ status: 'QUEUED', id: 'msg-1' });
    expect(tx.outboundMessage.create).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
