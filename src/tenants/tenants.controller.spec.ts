import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

describe('TenantsController', () => {
  it('should be defined', () => {
    const tenantsService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
    } as unknown as TenantsService;
    expect(new TenantsController(tenantsService)).toBeDefined();
  });
});
