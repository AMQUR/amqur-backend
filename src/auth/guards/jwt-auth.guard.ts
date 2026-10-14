import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { mfaRequiredRoles } from '../auth.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();

    const isPublic =
      this.reflector.get<boolean>(IS_PUBLIC_KEY, handler) ??
      this.reflector.get<boolean>(IS_PUBLIC_KEY, controller);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('Missing token');
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid token');
    }

    try {
      // Widget tokens may be signed with a dedicated rotatable secret.
      // The unverified typ claim only selects which secret to check —
      // the signature must still verify against that secret, so a forged
      // typ cannot bypass verification.
      const widgetSecret = this.config
        .get<string>('WIDGET_TOKEN_SECRET')
        ?.trim();
      const decoded = this.jwtService.decode<{ typ?: string } | null>(token);
      const useWidgetSecret = Boolean(
        widgetSecret && decoded && decoded.typ === 'widget',
      );

      const payload = useWidgetSecret
        ? await this.jwtService.verifyAsync(token, { secret: widgetSecret })
        : await this.jwtService.verifyAsync(token);
      // Only access/widget tokens authenticate API calls (MFA challenge tokens never do).
      if (payload?.typ !== 'access' && payload?.typ !== 'widget') {
        throw new UnauthorizedException('Invalid token type');
      }
      request.user = payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    // Staff roles that require MFA may only reach MFA enrollment + logout until verified.
    const user = request.user as {
      typ?: string;
      role?: string;
      amr?: string[];
    };
    if (
      user.typ === 'access' &&
      mfaRequiredRoles().includes(user.role ?? '') &&
      !(user.amr ?? []).includes('otp')
    ) {
      const url: string = request.originalUrl ?? request.url ?? '';
      if (!/\/auth\/(mfa\/(setup|confirm)|logout(-all)?)\b/.test(url)) {
        throw new ForbiddenException('mfa_enrollment_required');
      }
    }
    return true;
  }
}
