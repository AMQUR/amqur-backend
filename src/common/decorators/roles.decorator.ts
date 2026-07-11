import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export type AppRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF' | 'widget';

export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
