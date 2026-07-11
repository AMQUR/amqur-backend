import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

describe('AuthService', () => {
  it('should be defined', () => {
    const prisma = {} as PrismaService;
    const jwt = {} as JwtService;
    const config = {
      get: jest.fn().mockReturnValue('15m'),
    } as unknown as ConfigService;
    expect(new AuthService(prisma, jwt, config)).toBeDefined();
  });
});
