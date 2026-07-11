import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthUser } from '../common/decorators/current-user.decorator';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll(tenantId: string) {
    return this.prisma.user.findMany({
      where: { tenantId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        tenantId: true,
        locationId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByEmail(email: string, tenantId?: string) {
    if (tenantId) {
      return this.prisma.user.findUnique({
        where: { tenantId_email: { tenantId, email } },
        select: {
          id: true,
          email: true,
          password: true,
          role: true,
          tenantId: true,
          locationId: true,
        },
      });
    }
    return this.prisma.user.findFirst({
      where: { email },
      select: {
        id: true,
        email: true,
        password: true,
        role: true,
        tenantId: true,
        locationId: true,
      },
    });
  }

  async findById(id: string, tenantId?: string) {
    return this.prisma.user.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        tenantId: true,
        locationId: true,
      },
    });
  }

  async create(dto: CreateUserDto & { tenantId: string }, actor: AuthUser) {
    if (actor.role !== 'SUPER_ADMIN' && dto.role === Role.SUPER_ADMIN) {
      throw new ForbiddenException('Cannot assign SUPER_ADMIN');
    }

    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: dto.tenantId, email } },
    });
    if (existing) {
      throw new UnauthorizedException('User already exists');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        firstName: dto.firstName,
        lastName: dto.lastName,
        tenantId: dto.tenantId,
        role: dto.role ?? Role.STAFF,
        ...(dto.locationId && { locationId: dto.locationId }),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        tenantId: true,
        locationId: true,
        createdAt: true,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: dto.tenantId,
        userId: actor.sub,
        action: 'user.create',
        resource: 'User',
        resourceId: user.id,
      },
    });

    return user;
  }
}
