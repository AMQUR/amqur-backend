import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { AuthUser } from '../common/decorators/current-user.decorator';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.tenant.findMany({
      select: {
        id: true,
        slug: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { locations: true, users: true, vehicles: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  findOne(tenantId: string) {
    return this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        slug: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        locations: {
          select: {
            id: true,
            slug: true,
            name: true,
            address: true,
            phone: true,
          },
        },
      },
    });
  }

  async create(dto: CreateTenantDto, actor: AuthUser) {
    const tenant = await this.prisma.tenant.create({
      data: {
        name: dto.name,
        slug: dto.slug,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.sub === 'widget' ? undefined : actor.sub,
        action: 'tenant.create',
        resource: 'Tenant',
        resourceId: tenant.id,
        metadata: { slug: dto.slug },
      },
    });

    return tenant;
  }
}
