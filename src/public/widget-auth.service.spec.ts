import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { WidgetAuthService } from './widget-auth.service';

describe('WidgetAuthService origin fail-closed', () => {
  const jwt = { sign: jest.fn().mockReturnValue('tok') };
  const config = { get: jest.fn().mockReturnValue('4h') };

  function service(tenant: { id: string; allowedOrigins: string | null } | null) {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue(tenant),
      },
      location: {
        findFirst: jest.fn().mockResolvedValue(
          tenant ? { id: 'loc1', slug: 'pilot-rooftop' } : null,
        ),
      },
    };
    return new WidgetAuthService(prisma as never, jwt as never, config as never);
  }

  it('rejects when allowedOrigins is empty (fail closed)', async () => {
    const svc = service({ id: 't1', allowedOrigins: null });
    await expect(
      svc.createWidgetToken('dial-auto-group-staging', 'pilot-rooftop', 'https://a.com'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects unauthorized origin', async () => {
    const svc = service({
      id: 't1',
      allowedOrigins: 'https://widget-staging-staging.up.railway.app',
    });
    await expect(
      svc.createWidgetToken(
        'dial-auto-group-staging',
        'pilot-rooftop',
        'https://evil.example',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects missing origin header when allowlist is set', async () => {
    const svc = service({
      id: 't1',
      allowedOrigins: 'https://widget-staging-staging.up.railway.app',
    });
    await expect(
      svc.createWidgetToken('dial-auto-group-staging', 'pilot-rooftop', null),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('mints token for permitted origin', async () => {
    const svc = service({
      id: 't1',
      allowedOrigins: 'https://widget-staging-staging.up.railway.app',
    });
    const result = await svc.createWidgetToken(
      'dial-auto-group-staging',
      'pilot-rooftop',
      'https://widget-staging-staging.up.railway.app',
    );
    expect(result.token).toBe('tok');
  });

  it('rejects unknown tenant', async () => {
    const svc = service(null);
    await expect(
      svc.createWidgetToken('nope', 'pilot-rooftop', 'https://a.com'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
