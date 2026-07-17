import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';

const JWT_SECRET = 'admin-secret-0123456789abcdef0123456789';
const WIDGET_SECRET = 'widget-secret-0123456789abcdef012345678';

function contextFor(token?: string) {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    }),
  } as never;
}

describe('JwtAuthGuard widget-secret selection', () => {
  const jwt = new JwtService({ secret: JWT_SECRET });
  const reflector = { get: jest.fn().mockReturnValue(undefined) };

  function guard(widgetSecret?: string) {
    const config = {
      get: jest.fn((key: string) =>
        key === 'WIDGET_TOKEN_SECRET' ? widgetSecret : undefined,
      ),
    };
    return new JwtAuthGuard(jwt, config as never, reflector as never);
  }

  it('verifies widget-typ tokens with WIDGET_TOKEN_SECRET when set', async () => {
    const token = jwt.sign(
      { sub: 'widget', role: 'widget', typ: 'widget', tenantId: 't1' },
      { secret: WIDGET_SECRET },
    );
    await expect(
      guard(WIDGET_SECRET).canActivate(contextFor(token)),
    ).resolves.toBe(true);
  });

  it('rejects widget tokens signed with the OLD secret after rotation', async () => {
    // Signed with JWT_SECRET (the pre-rotation fallback), verified against
    // the new dedicated widget secret — must fail.
    const oldToken = jwt.sign({
      sub: 'widget',
      role: 'widget',
      typ: 'widget',
      tenantId: 't1',
    });
    await expect(
      guard(WIDGET_SECRET).canActivate(contextFor(oldToken)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still verifies staff tokens with JWT_SECRET when widget secret is set', async () => {
    const staffToken = jwt.sign({
      sub: 'user-1',
      role: 'ADMIN',
      tenantId: 't1',
    });
    await expect(
      guard(WIDGET_SECRET).canActivate(contextFor(staffToken)),
    ).resolves.toBe(true);
  });

  it('a forged typ=widget claim cannot make a bad signature pass', async () => {
    const forged = jwt.sign(
      { sub: 'attacker', role: 'ADMIN', typ: 'widget' },
      { secret: 'wrong-secret-0123456789abcdef0123456789' },
    );
    await expect(
      guard(WIDGET_SECRET).canActivate(contextFor(forged)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('falls back to JWT_SECRET for widget tokens when no widget secret set', async () => {
    const token = jwt.sign({ sub: 'widget', role: 'widget', typ: 'widget' });
    await expect(guard(undefined).canActivate(contextFor(token))).resolves.toBe(
      true,
    );
  });

  it('rejects missing token', async () => {
    await expect(
      guard(WIDGET_SECRET).canActivate(contextFor(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
