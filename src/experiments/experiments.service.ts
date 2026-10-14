import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import {
  assignVariant,
  compareRates,
  validateVariants,
  Variant,
} from './experiment-math';

const MANAGER = new Set(['SUPER_ADMIN', 'ADMIN', 'MANAGER']);

@Injectable()
export class ExperimentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  async create(
    tenantId: string,
    userId: string,
    b: { key: string; locationId?: string | null; variants: unknown },
  ) {
    if (!/^[a-z0-9-]{3,40}$/.test(b.key))
      throw new BadRequestException('key a-z0-9- (3–40)');
    let variants: Variant[];
    try {
      variants = validateVariants(b.variants);
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'invalid variants',
      );
    }
    if (b.locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: b.locationId, tenantId },
        select: { id: true },
      });
      if (!loc) throw new NotFoundException('Location not found');
    }
    return this.prisma.experiment.create({
      data: {
        tenantId,
        locationId: b.locationId ?? null,
        key: b.key,
        surface: 'greeting',
        variants: variants as unknown as Prisma.InputJsonValue,
        createdById: userId,
      },
    });
  }

  async setStatus(
    tenantId: string,
    user: { id: string; role: string },
    id: string,
    run: boolean,
  ) {
    if (!MANAGER.has(user.role)) throw new ForbiddenException();
    const ex = await this.prisma.experiment.findFirst({
      where: { id, tenantId },
    });
    if (!ex) throw new NotFoundException();
    if (run && ex.createdById === user.id && user.role !== 'SUPER_ADMIN')
      throw new ForbiddenException(
        'A different manager must start the experiment',
      );
    if (run) {
      const clash = await this.prisma.experiment.count({
        where: {
          tenantId,
          surface: ex.surface,
          status: 'RUNNING',
          NOT: { id },
        },
      });
      if (clash)
        throw new BadRequestException(
          'Another experiment is already running on this surface',
        );
    }
    const row = await this.prisma.experiment.update({
      where: { id },
      data: run
        ? { status: 'RUNNING', startedById: user.id, startedAt: new Date() }
        : { status: 'STOPPED', stoppedAt: new Date() },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: user.id,
        action: run ? 'experiment.started' : 'experiment.stopped',
        resource: 'Experiment',
        resourceId: id,
        metadata: { key: ex.key },
      },
    });
    return row;
  }

  list(tenantId: string) {
    return this.prisma.experiment.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The greeting variant for this conversation (or null). Logs one exposure per conversation. */
  async greetingFor(
    tenantId: string,
    locationId: string | null,
    conversationKey: string,
    alreadyExposed: boolean,
  ) {
    const ex = await this.prisma.experiment.findFirst({
      where: {
        tenantId,
        surface: 'greeting',
        status: 'RUNNING',
        OR: [{ locationId }, { locationId: null }],
      },
    });
    if (!ex) return null;
    const v = assignVariant(
      conversationKey,
      ex.key,
      ex.variants as unknown as Variant[],
    );
    if (!alreadyExposed)
      void this.analytics.trackEvent(
        tenantId,
        locationId,
        'experiment_exposure',
        { experimentKey: ex.key, variant: v.key },
        conversationKey,
      );
    return { experimentKey: ex.key, variant: v.key, text: v.text };
  }

  /** Results from real exposures and persisted outcomes only. */
  async results(tenantId: string, id: string) {
    const ex = await this.prisma.experiment.findFirst({
      where: { id, tenantId },
    });
    if (!ex) throw new NotFoundException();
    const variants = ex.variants as unknown as Variant[];
    const exposures = await this.prisma.analyticsEvent.findMany({
      where: {
        tenantId,
        eventType: 'experiment_exposure',
        // Only this run's exposures: a reused key never inherits an earlier run's data.
        occurredAt: { gte: ex.startedAt ?? ex.createdAt },
        properties: { path: ['experimentKey'], equals: ex.key },
      },
      select: { conversationExternalKey: true, properties: true },
      take: 50_000,
    });
    const byKey = new Map<string, string>();
    for (const e of exposures)
      if (e.conversationExternalKey)
        byKey.set(
          e.conversationExternalKey,
          String((e.properties as Record<string, unknown>).variant),
        );
    const convs = await this.prisma.conversation.findMany({
      where: { tenantId, externalKey: { in: [...byKey.keys()] } },
      select: { id: true, externalKey: true },
    });
    const ids = convs.map((c) => c.id);
    const [leads, appts] = await Promise.all([
      this.prisma.lead.findMany({
        where: { tenantId, conversationId: { in: ids } },
        select: { conversationId: true },
      }),
      this.prisma.appointment.findMany({
        where: { tenantId, conversationId: { in: ids } },
        select: { conversationId: true },
      }),
    ]);
    const lead = new Set(leads.map((l) => l.conversationId));
    const appt = new Set(appts.map((a) => a.conversationId));
    const arms = variants.map((v) => {
      const cs = convs.filter((c) => byKey.get(c.externalKey) === v.key);
      return {
        variant: v.key,
        exposures: [...byKey.values()].filter((x) => x === v.key).length,
        conversations: cs.length,
        leads: cs.filter((c) => lead.has(c.id)).length,
        appointmentRequests: cs.filter((c) => appt.has(c.id)).length,
      };
    });
    const control = arms[0];
    return {
      key: ex.key,
      status: ex.status,
      arms,
      leadComparison: arms.slice(1).map((a) => ({
        variant: a.variant,
        ...compareRates(
          { n: control.conversations, conversions: control.leads },
          { n: a.conversations, conversions: a.leads },
        ),
      })),
      note: 'Results are observational counts. A variant is never promoted automatically; below 200 conversations per arm the comparison is reported as insufficient.',
    };
  }
}
