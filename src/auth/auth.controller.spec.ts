import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  it('should be defined', () => {
    const authService = {
      login: jest.fn(),
      register: jest.fn(),
      bootstrap: jest.fn(),
      refresh: jest.fn(),
      logout: jest.fn(),
    } as unknown as AuthService;
    expect(new AuthController(authService)).toBeDefined();
  });
});
