import { isCredentialPath } from './app.module';

describe('the 20-per-minute credential throttle applies only to credential routes', () => {
  it.each([
    '/api/auth/login',
    '/api/auth/mfa/verify',
    '/api/auth',
    '/api/public/canary-redeem',
    '/api/canary/invites',
    '/api/auth/login?x=1',
  ])('covers %s', (p) => expect(isCredentialPath(p)).toBe(true));

  it.each([
    '/api/public/widget-config?tenantSlug=a&locationSlug=main',
    '/api/public/widget-token',
    '/api/public/store-status',
    '/api/chat',
    '/api/chat/stream',
    '/api/chat/event',
    '/api/health',
    '/api/authors',
  ])('does not cover %s', (p) => expect(isCredentialPath(p)).toBe(false));
});
