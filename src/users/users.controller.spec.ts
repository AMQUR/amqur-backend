import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  it('should be defined', () => {
    const usersService = {
      findAll: jest.fn(),
      create: jest.fn(),
    } as unknown as UsersService;
    expect(new UsersController(usersService)).toBeDefined();
  });
});
