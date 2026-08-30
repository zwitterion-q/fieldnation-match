import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { User } from '../users/user.entity';
import { JwtClaims } from './jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    private jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.users.findOne({ where: { email: email.toLowerCase() } });

    // Compare against a dummy hash when the user is absent so the response time
    // does not reveal whether an email exists.
    const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok || !user.active) throw new UnauthorizedException('invalid credentials');

    const perms = [...new Set(user.roles.flatMap(r => r.permissions.map(p => p.name)))];
    const claims: JwtClaims = {
      sub: user.id, email: user.email,
      roles: user.roles.map(r => r.name),
      perms,
      subject_type: user.subjectType, subject_id: user.subjectId,
    };
    return {
      access_token: await this.jwt.signAsync(claims),
      expires_in: 8 * 3600,
      user: {
        id: user.id, email: user.email, full_name: user.fullName,
        company_name: user.companyName,
        roles: claims.roles, permissions: perms,
        subject_type: user.subjectType, subject_id: user.subjectId,
      },
    };
  }

  async me(userId: number) {
    const u = await this.users.findOne({ where: { id: userId } });
    if (!u) throw new UnauthorizedException();
    return {
      id: u.id, email: u.email, full_name: u.fullName, company_name: u.companyName,
      roles: u.roles.map(r => r.name),
      permissions: [...new Set(u.roles.flatMap(r => r.permissions.map(p => p.name)))],
      subject_type: u.subjectType, subject_id: u.subjectId,
    };
  }
}
