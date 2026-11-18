import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ToolActionService } from './tool-action.service';
import { actionChecksum } from './tool-catalog';
import type { PrismaService } from '../prisma/prisma.service';
import type { OutboxService } from '../integrations/core/outbox.service';

const admin = {
  tenantId: 't1',
  userId: 'u1',
  role: 'ADMIN',
  boundLocationId: null,
};
const other = { ...admin, userId: 'u2' };

function pending(over: Record<string, unknown> = {}) {
  const input = { leadId: 'l1', note: 'hi' };
  const base = {
    id: 'a1',
    tenantId: 't1',
    locationId: null,
    toolName: 'crm.note.add',
    toolVersion: 1,
    input,
    consentRef: null,
    status: 'PENDING_APPROVAL',
    requestedByUserId: 'u1',
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
  return {
    ...base,
    checksum: actionChecksum({
      toolName: base.toolName as string,
      toolVersion: base.toolVersion as number,
      locationId: base.locationId as string | null,
      input: base.input,
      consentRef: base.consentRef as string | null,
    }),
  };
}

function setup(row: Record<string, unknown> | null = pending()) {
  const tx = {
    toolActionRequest: {
      create: jest
        .fn()
        .mockImplementation(async (a) => ({ id: 'new', ...a.data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    toolActionRequest: {
      findFirst: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    location: { findFirst: jest.fn().mockResolvedValue({ id: 'loc' }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation(async (fn) => fn(tx)),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue({ id: 'ob1' }) };
  return {
    svc: new ToolActionService(
      prisma as unknown as PrismaService,
      outbox as unknown as OutboxService,
    ),
    prisma,
    tx,
    outbox,
  };
}

describe('ToolActionService', () => {
  beforeEach(() => {
    process.env.TOOL_REGISTRY_ENABLED = 'true';
    delete process.env.TOOL_DISPATCH_ENABLED;
  });
  afterAll(() => {
    delete process.env.TOOL_REGISTRY_ENABLED;
  });

  it('is disabled by default and fails closed', async () => {
    delete process.env.TOOL_REGISTRY_ENABLED;
    const { svc } = setup();
    await expect(
      svc.propose(admin, { tool: 'crm.note.add', input: {} }),
    ).rejects.toThrow(ForbiddenException);
    await expect(svc.decide(other, 'a1', 'DENY')).rejects.toThrow(
      ForbiddenException,
    );
    expect(svc.catalog().enabled).toBe(false);
  });

  it('rejects unknown tools, invalid input and missing consent', async () => {
    const { svc, tx } = setup();
    await expect(
      svc.propose(admin, { tool: 'nope', input: {} }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      svc.propose(admin, { tool: 'crm.note.add', input: { leadId: 'l' } }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.propose(admin, {
        tool: 'message.send',
        input: { leadId: 'l', channel: 'SMS', body: 'b' },
      }),
    ).rejects.toThrow(/consent/);
    expect(tx.toolActionRequest.create).not.toHaveBeenCalled();
  });

  it('creates PENDING_APPROVAL with redacted input and an audit record, never executing', async () => {
    const { svc, tx, outbox } = setup();
    const row = (await svc.propose(admin, {
      tool: 'crm.note.add',
      input: { leadId: 'l1', note: 'call 555-123-4567' },
    })) as unknown as { input: { note: string }; status?: string };
    expect(row.input.note).not.toMatch(/555/);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('forces a bound manager to their rooftop and denies other rooftops', async () => {
    const mgr = { ...admin, role: 'MANAGER', boundLocationId: 'a' };
    const { svc, prisma } = setup();
    await expect(
      svc.propose(mgr, {
        tool: 'crm.note.add',
        input: { leadId: 'l', note: 'n' },
        locationId: 'b',
      }),
    ).rejects.toThrow(ForbiddenException);
    prisma.location.findFirst.mockResolvedValue(null);
    await expect(
      svc.propose(admin, {
        tool: 'crm.note.add',
        input: { leadId: 'l', note: 'n' },
        locationId: 'zzz',
      }),
    ).rejects.toThrow(ForbiddenException);
    const bound = setup(pending({ locationId: 'b' }));
    await expect(bound.svc.get(mgr, 'a1')).rejects.toThrow(ForbiddenException);
  });

  it('scopes every load by tenant', async () => {
    const { svc, prisma } = setup(null);
    await expect(svc.get(admin, 'a1')).rejects.toThrow(NotFoundException);
    expect(prisma.toolActionRequest.findFirst).toHaveBeenCalledWith({
      where: { id: 'a1', tenantId: 't1' },
    });
  });

  it('idempotency: same content replays, different content conflicts, race returns winner', async () => {
    const { svc, prisma, tx } = setup();
    const existing = pending();
    prisma.toolActionRequest.findUnique.mockResolvedValue(existing);
    const same = await svc.propose(admin, {
      tool: 'crm.note.add',
      input: { leadId: 'l1', note: 'hi' },
      idempotencyKey: 'key-12345',
    });
    expect(same).toBe(existing);
    await expect(
      svc.propose(admin, {
        tool: 'crm.note.add',
        input: { leadId: 'l1', note: 'different' },
        idempotencyKey: 'key-12345',
      }),
    ).rejects.toThrow(ConflictException);
    prisma.toolActionRequest.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue(existing);
    tx.toolActionRequest.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    expect(
      await svc.propose(admin, {
        tool: 'crm.note.add',
        input: { leadId: 'l1', note: 'hi' },
        idempotencyKey: 'key-12345',
      }),
    ).toBe(existing);
  });

  it('refuses self-approval, wrong role, non-pending, expired and stale checksum', async () => {
    const row = pending();
    const s = setup(row);
    await expect(
      s.svc.decide(admin, 'a1', 'APPROVE', { reviewedChecksum: row.checksum }),
    ).rejects.toThrow(/differ from the requester/);
    const hi = setup(
      pending({
        toolName: 'message.send',
        input: { leadId: 'l', channel: 'SMS', body: 'b' },
        consentRef: 'c',
      }),
    );
    await expect(
      hi.svc.decide({ ...other, role: 'MANAGER' }, 'a1', 'DENY'),
    ).rejects.toThrow(/Role may not decide/);
    const done = setup(pending({ status: 'APPROVED' }));
    await expect(done.svc.decide(other, 'a1', 'DENY')).rejects.toThrow(
      ConflictException,
    );
    const old = setup(pending({ expiresAt: new Date(0) }));
    await expect(
      old.svc.decide(other, 'a1', 'APPROVE', {
        reviewedChecksum: row.checksum,
      }),
    ).rejects.toThrow(/expired/);
    expect(old.prisma.toolActionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPIRED' } }),
    );
    await expect(
      s.svc.decide(other, 'a1', 'APPROVE', { reviewedChecksum: 'stale' }),
    ).rejects.toThrow(/differs/);
    await expect(s.svc.decide(other, 'a1', 'APPROVE')).rejects.toThrow(
      /differs/,
    );
    expect(s.tx.toolActionRequest.updateMany).not.toHaveBeenCalled();
  });

  it('approval alone never dispatches while the dispatch flag is off', async () => {
    const row = pending();
    const { svc, tx, outbox } = setup(row);
    await svc.decide(other, 'a1', 'APPROVE', {
      reviewedChecksum: row.checksum,
    });
    expect(tx.toolActionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'APPROVED' }),
      }),
    );
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('approval enqueues exactly one idempotent outbox event in the same transaction when dispatch is on', async () => {
    process.env.TOOL_DISPATCH_ENABLED = 'true';
    const row = pending();
    const { svc, tx, outbox } = setup(row);
    await svc.decide(other, 'a1', 'APPROVE', {
      reviewedChecksum: row.checksum,
    });
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'tool-action:a1',
        tx,
        payload: { actionId: 'a1' },
      }),
    );
  });

  it('denial and lost races never enqueue', async () => {
    process.env.TOOL_DISPATCH_ENABLED = 'true';
    const row = pending();
    const d = setup(row);
    await d.svc.decide(other, 'a1', 'DENY');
    expect(d.outbox.enqueue).not.toHaveBeenCalled();
    const race = setup(row);
    race.tx.toolActionRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      race.svc.decide(other, 'a1', 'APPROVE', {
        reviewedChecksum: row.checksum,
      }),
    ).rejects.toThrow(ConflictException);
    expect(race.outbox.enqueue).not.toHaveBeenCalled();
    expect(race.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('cancel only claims pending actions', async () => {
    const { svc, prisma } = setup();
    await svc.cancel(admin, 'a1');
    expect(prisma.toolActionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PENDING_APPROVAL' }),
      }),
    );
    prisma.toolActionRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.cancel(admin, 'a1')).rejects.toThrow(ConflictException);
  });
});
