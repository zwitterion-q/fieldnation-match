import { Body, Controller, Get, Post, Req, HttpCode } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { Public, RequirePermissions } from './jwt.strategy';
import { P } from '../rbac/permissions';

class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(4) password: string;
}

@Controller()
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public() @Post('auth/login') @HttpCode(200)
  login(@Body() dto: LoginDto) { return this.auth.login(dto.email, dto.password); }

  @Get('auth/me')
  me(@Req() req: any) { return this.auth.me(req.user.sub); }

  /** Demonstrates permission enforcement independent of role name. */
  @Get('auth/admin-check') @RequirePermissions(P.PLATFORM_ADMIN)
  adminOnly() { return { ok: true, message: 'you hold platform:admin' }; }

  @Public() @Get('health')
  health() { return { service: 'identity', status: 'ok' }; }
}
