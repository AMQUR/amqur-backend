import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { FilePurpose, FileScanStatus } from '@prisma/client';
import { UploadsService } from './uploads.service';

describe('UploadsService conversation attachments', () => {
  const prisma = {
    conversation: { findFirst: jest.fn() },
    fileObject: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const svc = new UploadsService(prisma as never);

  const cleanFile = {
    id: 'file-1',
    tenantId: 'tenant-a',
    originalName: 'scan.pdf',
    mimeType: 'application/pdf',
    byteSize: 100,
    purpose: FilePurpose.DOCUMENT,
    scannedStatus: FileScanStatus.CLEAN,
    conversationId: null as string | null,
    locationId: null,
    createdAt: new Date('2026-01-01'),
  };

  beforeEach(() => jest.resetAllMocks());

  it('attachToConversation denies cross-tenant file lookup', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      locationId: null,
    });
    prisma.fileObject.findFirst.mockResolvedValue(null);

    await expect(
      svc.attachToConversation({
        tenantId: 'tenant-a',
        conversationId: 'conv-1',
        fileId: 'file-other-tenant',
      }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.fileObject.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'file-other-tenant',
        tenantId: 'tenant-a',
        deletedAt: null,
      },
    });
    expect(prisma.fileObject.update).not.toHaveBeenCalled();
  });

  it('attachToConversation rejects non-CLEAN files', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      locationId: null,
    });
    prisma.fileObject.findFirst.mockResolvedValue({
      ...cleanFile,
      scannedStatus: FileScanStatus.PENDING,
    });

    await expect(
      svc.attachToConversation({
        tenantId: 'tenant-a',
        conversationId: 'conv-1',
        fileId: 'file-1',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.fileObject.update).not.toHaveBeenCalled();
  });

  it('attachToConversation allows SKIPPED outside production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      locationId: null,
    });
    prisma.fileObject.findFirst.mockResolvedValue({
      ...cleanFile,
      scannedStatus: FileScanStatus.SKIPPED,
      conversationId: null,
    });
    prisma.fileObject.update.mockResolvedValue({
      ...cleanFile,
      scannedStatus: FileScanStatus.SKIPPED,
      conversationId: 'conv-1',
    });

    await expect(
      svc.attachToConversation({
        tenantId: 'tenant-a',
        conversationId: 'conv-1',
        fileId: 'file-1',
      }),
    ).resolves.toMatchObject({ id: 'file-1' });
    process.env.NODE_ENV = prev;
  });

  it('listConversationAttachments scopes by tenant', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);

    await expect(
      svc.listConversationAttachments('tenant-a', 'conv-other-tenant'),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: { id: 'conv-other-tenant', tenantId: 'tenant-a' },
      select: { id: true },
    });
    expect(prisma.fileObject.findMany).not.toHaveBeenCalled();
  });

  it('listConversationAttachments returns CLEAN files with downloadPath', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
    prisma.fileObject.findMany.mockResolvedValue([
      {
        ...cleanFile,
        conversationId: 'conv-1',
      },
    ]);

    const result = await svc.listConversationAttachments('tenant-a', 'conv-1');

    expect(prisma.fileObject.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        conversationId: 'conv-1',
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        byteSize: true,
        purpose: true,
        scannedStatus: true,
        conversationId: true,
        createdAt: true,
      },
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].id).toBe('file-1');
    expect(result.attachments[0].scannedStatus).toBe(FileScanStatus.CLEAN);
    expect(result.attachments[0].downloadPath).toContain(
      '/uploads/file-1/download',
    );
  });

  it('attachToConversation links a CLEAN file', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      locationId: 'loc-1',
    });
    prisma.fileObject.findFirst.mockResolvedValue(cleanFile);
    prisma.fileObject.update.mockResolvedValue({
      ...cleanFile,
      conversationId: 'conv-1',
      locationId: 'loc-1',
    });

    const row = await svc.attachToConversation({
      tenantId: 'tenant-a',
      conversationId: 'conv-1',
      fileId: 'file-1',
    });

    expect(row.conversationId).toBe('conv-1');
    expect(row.downloadPath).toContain('/uploads/file-1/download');
    expect(prisma.fileObject.update).toHaveBeenCalledWith({
      where: { id: 'file-1' },
      data: {
        conversationId: 'conv-1',
        locationId: 'loc-1',
      },
    });
  });
});
