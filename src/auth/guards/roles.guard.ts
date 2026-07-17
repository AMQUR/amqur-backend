import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, AppRole } from '../../common/decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AppRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No roles required -> allow
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;

    // Works with your current JwtAuthGuard (payload) OR Passport (user object)
    const role: AppRole | undefined = user?.role;

    if (!role) {
      throw new ForbiddenException('Missing role');
    }

    if (!requiredRoles.includes(role)) {
      throw new ForbiddenException('Insufficient role');
    }

    return true;
  }
}
