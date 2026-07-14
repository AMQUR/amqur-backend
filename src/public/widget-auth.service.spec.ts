import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { WidgetAuthService } from './widget-auth.service';

describe('WidgetAuthService origin fail-closed', () => {
  const jwt = { sign: jest.fn().mockReturnValue('tok') };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'WIDGET_TOKEN_EXPIRES_IN') return '4h';
      if (key === 'CANARY_STRICT_ORIGINS') return '';
      if (key === 'CANARY_EMPLOYEE_ENABLED') return 'false';
      return undefined;
    }),
  };
  const canaryAuth = {
    isMasterEnabled: jest.fn().mockReturnValue(false),
    checkEligibility: jest.fn(),
  };

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
    return new WidgetAuthService(
      prisma as never,
      jwt as never,
      config as never,
      canaryAuth as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    canaryAuth.isMasterEnabled.mockReturnValue(false);
    config.get.mockImplementation((key: string) => {
      if (key === 'WIDGET_TOKEN_EXPIRES_IN') return '4h';
      if (key === 'CANARY_STRICT_ORIGINS') return '';
      return undefined;
    });
  });

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

  it('Jeep strict origin without canary session fails closed', async () => {
    canaryAuth.isMasterEnabled.mockReturnValue(true);
    canaryAuth.checkEligibility.mockResolvedValue({
      eligible: false,
      reason: 'missing_credential',
    });
    config.get.mockImplementation(((key: string) => {
      if (key === 'WIDGET_TOKEN_EXPIRES_IN') return '4h';
      if (key === 'CANARY_STRICT_ORIGINS') {
        return 'https://www.jeepofchicago.com,https://jeepofchicago.com';
      }
      return undefined;
    }) as never);
    const svc = service({
      id: 't1',
      allowedOrigins:
        'https://www.jeepofchicago.com,https://jeepofchicago.com,https://widget-staging-staging.up.railway.app',
    });
    await expect(
      svc.createWidgetToken(
        'dial-auto-group',
        'pilot-rooftop',
        'https://www.jeepofchicago.com',
        null,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Jeep strict origin with eligible canary session mints token', async () => {
    canaryAuth.isMasterEnabled.mockReturnValue(true);
    canaryAuth.checkEligibility.mockResolvedValue({ eligible: true });
    config.get.mockImplementation(((key: string) => {
      if (key === 'WIDGET_TOKEN_EXPIRES_IN') return '4h';
      if (key === 'CANARY_STRICT_ORIGINS') {
        return 'https://www.jeepofchicago.com,https://jeepofchicago.com';
      }
      return undefined;
    }) as never);
    const svc = service({
      id: 't1',
      allowedOrigins: 'https://www.jeepofchicago.com,https://jeepofchicago.com',
    });
    const result = await svc.createWidgetToken(
      'dial-auto-group',
      'pilot-rooftop',
      'https://www.jeepofchicago.com',
      'amqur_canary_emp=valid',
    );
    expect(result.token).toBe('tok');
    expect(canaryAuth.checkEligibility).toHaveBeenCalled();
  });
});
