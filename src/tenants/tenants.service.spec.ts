import { TenantsService } from './tenants.service';
import { PrismaService } from '../prisma/prisma.service';

describe('TenantsService', () => {
  it('should be defined', () => {
    expect(new TenantsService({} as PrismaService)).toBeDefined();
  });
});
