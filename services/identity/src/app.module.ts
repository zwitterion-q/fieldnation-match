import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { User } from './users/user.entity';
import { Role } from './rbac/role.entity';
import { Permission } from './rbac/permission.entity';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/jwt.strategy';
import { MetricsInterceptor, MetricsController } from './auth/metrics';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.IDENTITY_DSN || 'postgresql://fn:fn@localhost:55434/identity',
      entities: [User, Role, Permission],
      synchronize: true,   // demo only; a real deployment uses migrations
    }),
    TypeOrmModule.forFeature([User, Role, Permission]),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'fn-dev-secret-change-me',
      signOptions: { expiresIn: '8h', issuer: 'fn-identity' },
    }),
  ],
  controllers: [AuthController, MetricsController],
  // Guard registered globally: every route is protected unless marked @Public().
  // Fail-closed by default -- forgetting a decorator denies access rather than
  // silently exposing an endpoint.
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard },
              { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }],
})
export class AppModule {}
