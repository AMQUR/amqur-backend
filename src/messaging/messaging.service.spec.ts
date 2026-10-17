import { Prisma } from '@prisma/client';
import { MessagingService } from './messaging.service';

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
