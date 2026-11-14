import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
  Inject,
  HttpCode,
  Post,
  Res,
  UnauthorizedException,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { ConfigService } from '../../../config/config.service.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  ADMIN_PORTAL_AUTH_PROVIDER,
  ADMIN_SESSION_AUTHENTICATOR,
  ADMIN_SESSIONS,
  AdminAuthProviderError,
  AdminSessionUnavailable,
  type AdminAuthenticatedContext,
  type AdminPortalAuthProvider,
  type AdminSessionAuthenticator,
  type AdminSessions,
  type AdminSessionProvider,
  type AuthTokens,
} from '../../../modules/identity/contracts/admin-auth.js';
import type {
  IdentityAuthorizer,
  TokenVerifier,
} from '../../../modules/identity/contracts/identity.js';
import {
  IDENTITY_AUTHORIZER,
  TOKEN_VERIFIER,
  USER_PROFILES,
} from '../../../modules/identity/contracts/identity.js';
import type { UserProfiles } from '../../../modules/identity/contracts/identity.js';
import {
  adminSessionCookie,
  cookieSecure,
} from '../../../modules/identity/contracts/identity-guard.js';

class LoginDto {
  @ApiProperty({ format: 'email' }) @IsEmail() @Length(3, 254) email!: string;
  @ApiProperty() @IsString() @Length(1, 256) password!: string;
}
class ChallengeDto {
  @ApiProperty() @IsString() @Matches(/^[a-f0-9]{32}$/) challengeId!: string;
  @ApiProperty()
  @IsString()
  @Length(12, 128)
  @Matches(/[A-Za-z]/, { message: 'password must contain a letter' })
  @Matches(/\d/, { message: 'password must contain a digit' })
  newPassword!: string;
}
class ForgotDto {
  @ApiProperty({ format: 'email' }) @IsEmail() @Length(3, 254) email!: string;
}
class ConfirmForgotDto extends ForgotDto {
  @ApiProperty() @IsString() @Length(4, 40) confirmationCode!: string;
  @ApiProperty()
  @IsString()
  @Length(12, 128)
  @Matches(/[A-Za-z]/, { message: 'password must contain a letter' })
  @Matches(/\d/, { message: 'password must contain a digit' })
  newPassword!: string;
}
class LogoutDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allSessions?: boolean;
}

export const ADMIN_CSRF_HEADER = 'x-admin-csrf';
export const ADMIN_SESSION_COOKIE = 'admin_session';

export function readSessionCookie(
  header: string | undefined,
  name = ADMIN_SESSION_COOKIE,
): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

/** State-changing portal routes accept cross-site posts only from allowed origins. */
export function assertAllowedOrigin(
  request: { headers: { origin?: string; referer?: string } },
  allowedOrigins: readonly string[],
): void {
  const header = request.headers.origin ?? request.headers.referer;
  if (!header) return;
  let parsed: URL;
  try {
    parsed = new URL(header);
  } catch {
    throw new ForbiddenException({ code: 'FORBIDDEN' });
  }
  if (!allowedOrigins.includes(parsed.origin)) throw new ForbiddenException({ code: 'FORBIDDEN' });
}

/** Admin portal session routes (P14): no bearer guard; the session cookie is the credential. */
@Controller('v1/admin/auth')
@UseInterceptors(DomainErrorInterceptor)
export class AdminAuthController {
  constructor(
    @Inject(ADMIN_PORTAL_AUTH_PROVIDER) private readonly provider: AdminPortalAuthProvider,
    @Inject(ADMIN_SESSIONS) private readonly sessions: AdminSessions,
    @Inject(ADMIN_SESSION_AUTHENTICATOR)
    private readonly authenticator: AdminSessionAuthenticator,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(IDENTITY_AUTHORIZER) private readonly identities: IdentityAuthorizer,
    @Inject(USER_PROFILES) private readonly profiles: UserProfiles,
    private readonly config: ConfigService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminAuthLogin' })
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    let outcome;
    try {
      outcome = await this.provider.passwordLogin(body.email.trim().toLowerCase(), body.password);
    } catch (error: unknown) {
      throw this.providerError(error, { failure: 401 });
    }
    if (outcome.status === 'CHALLENGE') {
      const challengeId = randomBytes(16).toString('hex');
      await this.sessions.putChallenge(challengeId, {
        pool: 'WORKFORCE',
        username: body.email.trim().toLowerCase(),
        providerSession: outcome.providerSession,
      });
      return { status: 'CHALLENGE', challenge: outcome.challenge, challengeId };
    }
    const established = await this.establish(outcome.tokens);
    setSessionCookie(reply, established.session.sessionId, established.session.expiresAt);
    return {
      status: 'AUTHENTICATED',
      admin: established.admin,
      csrfToken: established.session.csrfToken,
    };
  }

  @Post('challenge')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminAuthChallenge' })
  async challenge(
    @Body() body: ChallengeDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    assertAllowedOrigin(reply.request, this.allowedOrigins);
    const state = await this.sessions.takeChallenge(body.challengeId);
    if (!state) throw new HttpException({ code: 'INVALID_CHALLENGE' }, 400);
    let outcome;
    try {
      outcome = await this.provider.respondToChallenge(state.providerSession, body.newPassword);
    } catch (error: unknown) {
      throw this.providerError(error, { failure: 400, failureCode: 'INVALID_CHALLENGE' });
    }
    const established = await this.establish(outcome.tokens);
    setSessionCookie(reply, established.session.sessionId, established.session.expiresAt);
    return {
      status: 'AUTHENTICATED',
      admin: established.admin,
      csrfToken: established.session.csrfToken,
    };
  }

  @Post('forgot-password')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminAuthForgotPassword' })
  async forgotPassword(@Body() body: ForgotDto): Promise<{ status: 'SENT' }> {
    try {
      await this.provider.forgotPassword(body.email.trim().toLowerCase());
    } catch (error: unknown) {
      // Provider outages stay retryable; unknown accounts still answer the generic response.
      if (error instanceof AdminAuthProviderError && error.kind === 'provider_unavailable')
        throw new HttpException({ code: 'ExternalServiceUnavailable' }, 503);
      if (!(error instanceof AdminAuthProviderError)) throw error;
    }
    return { status: 'SENT' };
  }

  @Post('forgot-password/confirm')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminAuthForgotPasswordConfirm' })
  async confirmForgotPassword(
    @Body() body: ConfirmForgotDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ status: 'RESET' }> {
    assertAllowedOrigin(reply.request, this.allowedOrigins);
    try {
      await this.provider.confirmForgotPassword(
        body.email.trim().toLowerCase(),
        body.confirmationCode,
        body.newPassword,
      );
    } catch (error: unknown) {
      if (error instanceof AdminAuthProviderError && error.kind === 'provider_unavailable')
        throw new HttpException({ code: 'ExternalServiceUnavailable' }, 503);
      throw new HttpException({ code: 'INVALID_RESET' }, 400);
    }
    return { status: 'RESET' };
  }

  @Get('session')
  @ApiOperation({ operationId: 'adminAuthSession' })
  async session(@Res({ passthrough: true }) reply: FastifyReply): Promise<unknown> {
    const sessionId = readSessionCookie(reply.request.headers.cookie);
    if (!sessionId) throw new UnauthorizedException({ code: 'SESSION_EXPIRED' });
    let context: AdminAuthenticatedContext;
    try {
      context = await this.authenticator.authenticateWithRotation(sessionId);
    } catch (error: unknown) {
      throw this.sessionError(error);
    }
    if (context.rotation)
      reply.header(
        'set-cookie',
        adminSessionCookie(
          context.rotation.session.sessionId,
          new Date(context.rotation.session.expiresAt),
          { secure: cookieSecure(reply.request) },
        ),
      );
    return {
      admin: {
        userId: context.principal.userId,
        email: context.identity.email ?? '',
        name: context.identity.name ?? '',
        role: 'ADMIN',
      },
      csrfToken: context.csrfToken,
    };
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminAuthLogout' })
  async logout(
    @Body() body: LogoutDto,
    @Headers(ADMIN_CSRF_HEADER) csrf: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const request = reply.request;
    assertAllowedOrigin(request, this.allowedOrigins);
    const sessionId = readSessionCookie(request.headers.cookie);
    if (!sessionId) throw new UnauthorizedException({ code: 'SESSION_EXPIRED' });
    if (!(await this.sessions.verifyCsrf(sessionId, csrf ?? '')))
      throw new ForbiddenException({ code: 'CSRF_TOKEN_INVALID' });
    if (body.allSessions) {
      const session = await this.sessions.resolve(sessionId);
      await this.sessions.revokeAllForUser(session.userId);
    } else await this.sessions.revoke(sessionId);
    reply.header(
      'set-cookie',
      adminSessionCookie('', new Date(0), { clear: true, secure: cookieSecure(request) }),
    );
    return { status: 'LOGGED_OUT' };
  }

  private get allowedOrigins(): string[] {
    return this.config
      .get('CORS_ALLOWED_ORIGINS')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  /** Verifies the provider tokens, authorizes the admin audience and enforces SUPER_ADMIN. */
  private async establish(tokens: AuthTokens) {
    const identity = await this.verifier.verify(tokens.accessToken, 'admin', 'access');
    const principal = await this.identities.authorize(identity, 'admin');
    if (!principal.roles.includes('SUPER_ADMIN'))
      throw new ForbiddenException({ code: 'FORBIDDEN' });
    const provider: AdminSessionProvider =
      this.config.get('AUTH_PROVIDER') === 'local' ? 'local' : 'cognito';
    const session = await this.sessions.create(principal.userId, provider, tokens);
    // Access tokens carry no profile claims — resolve email/name from the database.
    const profile = await this.profiles.get(principal.userId).catch(() => null);
    return {
      session,
      admin: {
        userId: principal.userId,
        email: profile?.email || identity.email || '',
        name: profile?.name || identity.name || '',
        role: 'ADMIN',
      },
    };
  }

  private providerError(
    error: unknown,
    mapping: { failure: number; failureCode?: string },
  ): unknown {
    if (error instanceof AdminAuthProviderError) {
      // Provider outages stay retryable: translate to the existing external-service 503 contract.
      if (error.kind === 'provider_unavailable')
        return new HttpException({ code: 'ExternalServiceUnavailable' }, 503);
      if (error.kind === 'policy_violation')
        return new HttpException({ code: 'INVALID_INPUT' }, 400);
      return new HttpException(
        { code: mapping.failureCode ?? 'INVALID_CREDENTIALS' },
        mapping.failure,
      );
    }
    return error;
  }

  private sessionError(error: unknown): unknown {
    if (error instanceof AdminSessionUnavailable)
      return new HttpException({ code: 'ExternalServiceUnavailable' }, 503);
    if (error instanceof ForbiddenException || error instanceof HttpException) return error;
    if (error instanceof Error) {
      if (error.message === 'SESSION_REPLACED')
        return new HttpException({ code: 'SESSION_REPLACED' }, 401);
      if (error.message === 'ACCOUNT_DISABLED' || error.message === 'PROFILE_NOT_INITIALIZED')
        return new ForbiddenException({ code: error.message });
      if (error.message === 'FORBIDDEN') return new ForbiddenException({ code: 'FORBIDDEN' });
    }
    return new UnauthorizedException({ code: 'SESSION_EXPIRED' });
  }
}

function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: string): void {
  reply.header(
    'set-cookie',
    adminSessionCookie(sessionId, new Date(expiresAt), { secure: cookieSecure(reply.request) }),
  );
}
