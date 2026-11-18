import { ForbiddenException } from '@nestjs/common';
import { WIDGET_TOKEN_DENIED, WidgetAuthService } from './widget-auth.service';

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

  function service(
    tenant: { id: string; allowedOrigins: string | null } | null,
  ) {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue(tenant),
      },
      location: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
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
      svc.createWidgetToken(
        'dial-auto-group-staging',
        'pilot-rooftop',
        'https://a.com',
      ),
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

  it('signs with dedicated WIDGET_TOKEN_SECRET when configured', async () => {
    config.get.mockImplementation(((key: string) => {
      if (key === 'WIDGET_TOKEN_EXPIRES_IN') return '4h';
      if (key === 'WIDGET_TOKEN_SECRET')
        return 'rotated-widget-secret-0123456789abcdef';
      if (key === 'CANARY_STRICT_ORIGINS') return '';
      return undefined;
    }) as never);
    const svc = service({
      id: 't1',
      allowedOrigins: 'https://widget-staging-staging.up.railway.app',
    });
    await svc.createWidgetToken(
      'dial-auto-group-staging',
      'pilot-rooftop',
      'https://widget-staging-staging.up.railway.app',
    );
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ typ: 'widget' }),
      expect.objectContaining({
        secret: 'rotated-widget-secret-0123456789abcdef',
      }),
    );
  });

  it('omits secret override (falls back to JWT_SECRET) when unset', async () => {
    const svc = service({
      id: 't1',
      allowedOrigins: 'https://widget-staging-staging.up.railway.app',
    });
    await svc.createWidgetToken(
      'dial-auto-group-staging',
      'pilot-rooftop',
      'https://widget-staging-staging.up.railway.app',
    );
    const opts = (jwt.sign as jest.Mock).mock.calls.at(-1)?.[1] as Record<
      string,
      unknown
    >;
    expect(opts).not.toHaveProperty('secret');
  });

  it('refuses every failure mode identically (no tenant enumeration)', async () => {
    const good = 'https://www.example-dealer.com';
    const unknownLocation = service({ id: 't1', allowedOrigins: good });
    (
      unknownLocation as unknown as {
        prisma: { location: { findFirst: jest.Mock } };
      }
    ).prisma.location.findFirst.mockResolvedValue(null);

    const attempts: Array<Promise<unknown>> = [
      service(null).createWidgetToken('nope', 'main', good),
      service({ id: 't1', allowedOrigins: null }).createWidgetToken(
        't',
        'main',
        good,
      ),
      service({ id: 't1', allowedOrigins: ' , ' }).createWidgetToken(
        't',
        'main',
        good,
      ),
      service({ id: 't1', allowedOrigins: good }).createWidgetToken(
        't',
        'main',
        'https://evil.example',
      ),
      service({ id: 't1', allowedOrigins: good }).createWidgetToken(
        't',
        'main',
        null,
      ),
      unknownLocation.createWidgetToken('t', 'nope', good),
    ];

    const outcomes = await Promise.all(
      attempts.map((p) =>
        p.then(
          () => 'issued',
          (e: ForbiddenException) =>
            `${e.constructor.name}:${e.getStatus()}:${e.message}`,
        ),
      ),
    );
    expect(new Set(outcomes)).toEqual(
      new Set([`ForbiddenException:403:${WIDGET_TOKEN_DENIED}`]),
    );
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('binds the token to the normalised origin it was issued for', async () => {
    const svc = service({
      id: 't1',
      allowedOrigins: 'https://www.example-dealer.com',
    });
    await svc.createWidgetToken(
      't',
      'main',
      '  HTTPS://WWW.Example-Dealer.com ',
    );
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        typ: 'widget',
        tenantId: 't1',
        locationId: 'loc1',
        origin: 'https://www.example-dealer.com',
      }),
      expect.anything(),
    );
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
