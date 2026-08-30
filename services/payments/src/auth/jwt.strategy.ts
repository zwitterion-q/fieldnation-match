import { Injectable, CanActivate, ExecutionContext, UnauthorizedException,
         ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

export const PERMISSIONS_KEY = 'required_permissions';
export const PUBLIC_KEY = 'is_public';

/** Route needs no token at all. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Route requires ALL of these permissions. */
export const RequirePermissions = (...perms: string[]) =>
  SetMetadata(PERMISSIONS_KEY, perms);

export interface JwtClaims {
  sub: number;            // user id
  email: string;
  roles: string[];
  perms: string[];        // flattened, so downstream services never query identity
  subject_type?: string;  // technician | hirer
  subject_id?: number;
}

/**
 * One guard doing authentication and authorisation.
 *
 * Permissions are flattened INTO the token. Downstream services therefore never
 * call identity to authorise a request -- identity being down cannot take the
 * platform down with it. The cost is staleness: a permission revoked mid-session
 * stays valid until the token expires, which is why tokens are short-lived.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY,
      [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('missing bearer token');

    let claims: JwtClaims;
    try {
      claims = await this.jwt.verifyAsync<JwtClaims>(token);
    } catch {
      throw new UnauthorizedException('invalid or expired token');
    }
    req.user = claims;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY,
      [ctx.getHandler(), ctx.getClass()]) || [];
    if (required.length === 0) return true;

    const missing = required.filter(p => !claims.perms.includes(p));
    if (missing.length) {
      throw new ForbiddenException(`missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
