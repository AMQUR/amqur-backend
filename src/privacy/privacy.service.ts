import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

function normEmail(e?: string) {
  return e?.trim().toLowerCase() || undefined;
}
function normPhone(p?: string) {
  const d = (p ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : undefined;
}

/**
 * Operator-initiated privacy requests (access/export, deletion via pseudonymization).
 * Identity matching is EXACT (normalized email / last-10 phone digits) — never fuzzy.
 * Audit logs and consent evidence are retained (pseudonymized endpoint hashes) because
 * policy requires proof of consent/opt-out history.
 */
@Injectable()
export class PrivacyService {
  constructor(private readonly prisma: PrismaService) {}

  private where(tenantId: string, q: { email?: string; phone?: string }) {
    const email = normEmail(q.email);
    const phone = normPhone(q.phone);
    if (!email && !phone)
      throw new BadRequestException('Provide an exact email or phone');
    return { tenantId, email, phone };
  }

  async lookup(tenantId: string, q: { email?: string; phone?: string }) {
    const { email, phone } = this.where(tenantId, q);
    const leadOr = [
      ...(email ? [{ email }] : []),
      ...(phone ? [{ phone: { endsWith: phone } }] : []),
    ];
    const leads = await this.prisma.lead.findMany({
      where: { tenantId, OR: leadOr },
    });
    const convIds = leads
      .map((l) => l.conversationId)
      .filter((x): x is string => !!x);
    const custOr = [
      ...(email ? [{ customerEmail: email }] : []),
      ...(phone ? [{ customerPhone: { endsWith: phone } }] : []),
    ];
    const [conversations, appointments, trades, finance, parts, consents] =
      await Promise.all([
        this.prisma.conversation.findMany({
          where: { tenantId, id: { in: convIds } },
          include: { messages: { orderBy: { createdAt: 'asc' } } },
        }),
        this.prisma.appointment.findMany({
          where: {
            tenantId,
            OR: [{ conversationId: { in: convIds } }, ...custOr],
          },
        }),
        this.prisma.tradeRequest.findMany({
          where: {
            tenantId,
            OR: [{ conversationId: { in: convIds } }, ...custOr],
          },
        }),
        this.prisma.financeRequest.findMany({
          where: {
            tenantId,
            OR: [{ conversationId: { in: convIds } }, ...custOr],
          },
        }),
        this.prisma.partsInquiry.findMany({
          where: {
            tenantId,
            OR: [{ conversationId: { in: convIds } }, ...custOr],
          },
        }),
        this.prisma.consentRecord.findMany({
          where: {
            tenantId,
            OR: [
              ...(email ? [{ endpoint: email }] : []),
              ...(phone ? [{ endpoint: { endsWith: phone } }] : []),
            ],
          },
        }),
      ]);
    return {
      leads,
      conversations,
      appointments,
      trades,
      finance,
      parts,
      consents,
    };
  }

  async export(
    tenantId: string,
    actorId: string,
    q: { email?: string; phone?: string },
  ) {
    const data = await this.lookup(tenantId, q);
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: actorId,
        action: 'privacy.export',
        metadata: {
          leads: data.leads.length,
          conversations: data.conversations.length,
        },
      },
    });
    return { exportedAt: new Date().toISOString(), ...data };
  }

  /** Deletion request: remove message content and contact PII; keep non-identifying business records. */
  async pseudonymize(
    tenantId: string,
    actorId: string,
    q: { email?: string; phone?: string },
  ) {
    const data = await this.lookup(tenantId, q);
    const tag = (s: string) =>
      `redacted:${createHash('sha256').update(`${tenantId}:${s}`).digest('hex').slice(0, 12)}`;
    const convIds = data.conversations.map((c) => c.id);
    const R = '[deleted at customer request]';
    await this.prisma.$transaction([
      this.prisma.message.updateMany({
        where: { conversationId: { in: convIds } },
        data: { content: R, metadata: { redacted: true } },
      }),
      this.prisma.conversation.updateMany({
        where: { id: { in: convIds }, tenantId },
        data: { state: {} },
      }),
      this.prisma.lead.updateMany({
        where: { tenantId, id: { in: data.leads.map((l) => l.id) } },
        data: {
          firstName: null,
          lastName: null,
          email: null,
          phone: null,
          notes: null,
          status: 'CLOSED',
        },
      }),
      this.prisma.appointment.updateMany({
        where: { tenantId, id: { in: data.appointments.map((a) => a.id) } },
        data: {
          customerName: null,
          customerEmail: null,
          customerPhone: null,
          notes: null,
        },
      }),
      this.prisma.tradeRequest.updateMany({
        where: { tenantId, id: { in: data.trades.map((a) => a.id) } },
        data: {
          customerName: null,
          customerEmail: null,
          customerPhone: null,
          notes: null,
        },
      }),
      this.prisma.financeRequest.updateMany({
        where: { tenantId, id: { in: data.finance.map((a) => a.id) } },
        data: {
          customerName: null,
          customerEmail: null,
          customerPhone: null,
          notes: null,
        },
      }),
      this.prisma.partsInquiry.updateMany({
        where: { tenantId, id: { in: data.parts.map((a) => a.id) } },
        data: {
          customerName: null,
          customerEmail: null,
          customerPhone: null,
          notes: null,
        },
      }),
      ...data.consents.map((c) =>
        this.prisma.consentRecord.update({
          where: { id: c.id },
          data: {
            endpoint: tag(c.endpoint),
            evidence: { pseudonymized: true },
          },
        }),
      ),
    ]);
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: actorId,
        action: 'privacy.pseudonymize',
        metadata: {
          conversations: convIds.length,
          leads: data.leads.length,
          consentsRetainedPseudonymized: data.consents.length,
        },
      },
    });
    return {
      ok: true,
      conversations: convIds.length,
      leads: data.leads.length,
    };
  }
}
