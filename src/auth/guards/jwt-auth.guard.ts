import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
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
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
