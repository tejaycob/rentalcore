// src/auth/auth.service.ts
//
// Password hashing (bcrypt) + JWT issuance sit here, separate from the
// repository (pure data access) and the controller (HTTP shape only).

import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { AuthRepository, UserRow } from './auth.repository';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    companyId: string | null;
    role: UserRow['role'];
    name: string;
    email: string;
    locale: 'pt' | 'en';
  };
}

function toPublicUser(row: UserRow): AuthResult['user'] {
  return {
    id: row.id,
    companyId: row.companyId,
    role: row.role,
    name: row.name,
    email: row.email,
    locale: row.locale,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly authRepository: AuthRepository,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    if (await this.authRepository.emailExists(dto.email)) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = await this.authRepository.registerCompanyAndOwner({
      companyName: dto.companyName,
      countryCode: dto.countryCode,
      currency: dto.currency,
      name: dto.name,
      email: dto.email,
      passwordHash,
      locale: dto.locale,
      phone: dto.phone,
    });

    return this.issueTokens(user);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.authRepository.findByEmail(dto.email);
    // Compare against a dummy hash when the user doesn't exist so this
    // path takes roughly the same time either way — bcrypt.compare is
    // the expensive step, and skipping it on a miss is a timing signal
    // an attacker could use to enumerate valid emails.
    const hashToCheck = user?.passwordHash ?? '$2b$12$invalidsaltinvalidsaltinvalidsaltinvalidsalt';
    const passwordMatches = await bcrypt.compare(dto.password, hashToCheck);

    if (!user || !passwordMatches || !user.active) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.issueTokens(user);
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    const stored = await this.authRepository.findValidRefreshToken(refreshToken);
    if (!stored) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.authRepository.findById(stored.userId);
    if (!user || !user.active) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Rotate: the old refresh token is single-use. Revoking it here means
    // a stolen-but-already-used refresh token can't be replayed.
    await this.authRepository.revokeRefreshToken(refreshToken);

    return this.issueTokens(user);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.authRepository.revokeRefreshToken(refreshToken);
  }

  private async issueTokens(user: UserRow): Promise<AuthResult> {
    const accessToken = this.jwtService.sign(
      { sub: user.id, companyId: user.companyId, role: user.role },
      { expiresIn: ACCESS_TOKEN_TTL },
    );

    const refreshToken = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    await this.authRepository.storeRefreshToken(user.id, refreshToken, expiresAt);

    return { accessToken, refreshToken, user: toPublicUser(user) };
  }
}
