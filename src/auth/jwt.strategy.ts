import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: (req) => {
        const auth = req?.headers?.authorization;

        if (!auth) return null;
        if (!auth.startsWith('Bearer ')) return null;

        return auth.replace('Bearer ', '');
      },
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      ignoreExpiration: false,
    });
  }

  async validate(payload: any) {
    if (!payload) {
      return null;
    }

    const user = await this.usersService.findById(payload.sub);

    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }
}
