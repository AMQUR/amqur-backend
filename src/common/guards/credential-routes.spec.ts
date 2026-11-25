import { readFileSync } from 'fs';
import { join } from 'path';
import { isCredentialController } from './credential-routes';

describe('the 20-per-minute credential throttle is chosen by controller, not by URL text', () => {
  it('covers the controllers that accept credentials or invite tokens', () => {
    expect(isCredentialController('AuthController')).toBe(true);
    expect(isCredentialController('CanaryAuthController')).toBe(true);
  });

  it('does not cover the public widget or chat controllers', () => {
    for (const n of ['PublicController', 'ChatController', '', undefined])
      expect(isCredentialController(n)).toBe(false);
  });

  it('the names are the real class names', () => {
    const src = (p: string) =>
      readFileSync(join(__dirname, '..', '..', p), 'utf8');
    expect(src('auth/auth.controller.ts')).toContain(
      'export class AuthController',
    );
    expect(src('public/canary-auth.controller.ts')).toContain(
      'export class CanaryAuthController',
    );
  });
});
