import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UsersService', () => {
  it('should be defined', () => {
    expect(new UsersService({} as PrismaService)).toBeDefined();
  });
});
