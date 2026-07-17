import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertFeedUrlAllowed } from '../common/security/feed-url.guard';

@Injectable()
export class LocationsService {
  constructor(private prisma: PrismaService) {}

  findAll(tenantId: string) {
    return this.prisma.location.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
  }

  async create(
    data: CreateLocationDto & { tenantId: string },
    actor: AuthUser,
  ) {
    if (data.inventoryFeedUrl) {
      try {
        assertFeedUrlAllowed(data.inventoryFeedUrl);
      } catch (e) {
        throw new BadRequestException(
          e instanceof Error ? e.message : 'Invalid inventory feed URL',
        );
      }
    }

    const location = await this.prisma.location.create({
      data: {
        tenantId: data.tenantId,
        name: data.name,
        slug: data.slug,
        address: data.address,
        phone: data.phone,
        inventoryFeedUrl: data.inventoryFeedUrl,
        inventoryFeedType: data.inventoryFeedType,
        timezone: data.timezone ?? 'America/Chicago',
      },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: data.tenantId,
        userId: actor.sub,
        action: 'location.create',
        resource: 'Location',
        resourceId: location.id,
      },
    });

    return location;
  }
}
