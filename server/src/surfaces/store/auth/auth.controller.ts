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
  STORE_PORTAL_AUTH_PROVIDER,
  STORE_SESSION_AUTHENTICATOR,
  STORE_SESSIONS,
  AdminAuthProviderError,
  AdminSessionUnavailable,
  type AdminAuthenticatedContext,
  type AdminPortalAuthProvider,
  type AdminSessionAuthenticator,
  type AdminSessionProvider,
  type AdminSessions,
  type AuthTokens,
} from '../../../modules/identity/contracts/admin-auth.js';
import type {
  IdentityAuthorizer,
  IdentityAccess,
  TokenVerifier,
} from '../../../modules/identity/contracts/identity.js';
import {
  IDENTITY_ACCESS,
  IDENTITY_AUTHORIZER,
  TOKEN_VERIFIER,
  USER_PROFILES,
} from '../../../modules/identity/contracts/identity.js';
import type { UserProfiles } from '../../../modules/identity/contracts/identity.js';
import {
  cookieSecure,
  storeSessionCookie,
} from '../../../modules/identity/contracts/identity-guard.js';
import { assertAllowedOrigin, readSessionCookie } from '../../admin/auth/auth.controller.js';

class StoreLoginDto {
  @ApiProperty({ format: 'email' }) @IsEmail() @Length(3, 254) email!: string;
  @ApiProperty() @IsString() @Length(1, 256) password!: string;
  /** When false the session cookie dies with the browser; refreshes still survive. */
  @ApiPropertyOptional() @IsOptional() @IsBoolean() remember?: boolean;
}
class StoreChallengeDto {
  @ApiProperty() @IsString() @Matches(/^[a-f0-9]{32}$/) challengeId!: string;
  @ApiProperty()
  @IsString()
  @Length(12, 128)
  @Matches(/[A-Za-z]/, { message: 'password must contain a letter' })
  @Matches(/\d/, { message: 'password must contain a digit' })
  newPassword!: string;
}
class StoreForgotDto {
  @ApiProperty({ format: 'email' }) @IsEmail() @Length(3, 254) email!: string;
}
class StoreConfirmForgotDto extends StoreForgotDto {
  @ApiProperty() @IsString() @Length(4, 40) confirmationCode!: string;
  @ApiProperty()
  @IsString()
  @Length(12, 128)
  @Matches(/[A-Za-z]/, { message: 'password must contain a letter' })
  @Matches(/\d/, { message: 'password must contain a digit' })
  newPassword!: string;
}
class StoreLogoutDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allSessions?: boolean;
}

export const STORE_CSRF_HEADER = 'x-store-csrf';
export const STORE_SESSION_COOKIE = 'store_session';

/**
 * Store-manager portal session routes. No bearer guard — the store_session
 * cookie is the credential, sealed against the STORE_SESSION_KEYS_JSON ring
 * and fully independent from the admin portal's cookie, keys and revocation.
 * Bearer access for existing store API clients is untouched.
 */
@Controller('v1/store/auth')
@UseInterceptors(DomainErrorInterceptor)
export class StoreAuthController {
  constructor(
    @Inject(STORE_PORTAL_AUTH_PROVIDER) private readonly provider: AdminPortalAuthProvider,
    @Inject(STORE_SESSIONS) private readonly sessions: AdminSessions,
    @Inject(STORE_SESSION_AUTHENTICATOR)
    private readonly authenticator: AdminSessionAuthenticator,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(IDENTITY_AUTHORIZER) private readonly identities: IdentityAuthorizer,
    @Inject(IDENTITY_ACCESS) private readonly access: IdentityAccess,
    @Inject(USER_PROFILES) private readonly profiles: UserProfiles,
    private readonly config: ConfigService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ operationId: 'storeAuthLogin' })
  async login(
    @Body() body: StoreLoginDto,
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
    setStoreSessionCookie(
      reply,
      established.session.sessionId,
      established.session.expiresAt,
      body.remember === false,
    );
    return {
      status: 'AUTHENTICATED',
      manager: established.manager,
      csrfToken: established.session.csrfToken,
      idleExpiresAt: await this.idleExpiresAt(established.session.sessionId),
    };
  }

  @Post('challenge')
  @HttpCode(200)
  @ApiOperation({ operationId: 'storeAuthChallenge' })
  async challenge(
    @Body() body: StoreChallengeDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    assertAllowedOrigin(reply.request, this.allowedOrigins);
    const state = await this.sessions.takeChallenge(body.challengeId);
    if (!state) throw new HttpException({ code: 'INVALID_CHALLENGE' }, 400);
    let outcome;
    try {
      outcome = await this.provider.respondToChallenge(
        state.providerSession,
        body.newPassword,
        state.username,
      );
    } catch (error: unknown) {
      throw this.providerError(error, { failure: 400, failureCode: 'INVALID_CHALLENGE' });
    }
    const established = await this.establish(outcome.tokens);
    setStoreSessionCookie(reply, established.session.sessionId, established.session.expiresAt);
    return {
      status: 'AUTHENTICATED',
      manager: established.manager,
      csrfToken: established.session.csrfToken,
      idleExpiresAt: await this.idleExpiresAt(established.session.sessionId),
    };
  }

  @Post('forgot-password')
  @HttpCode(200)
  @ApiOperation({ operationId: 'storeAuthForgotPassword' })
  async forgotPassword(@Body() body: StoreForgotDto): Promise<{ status: 'SENT' }> {
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
  @ApiOperation({ operationId: 'storeAuthForgotPasswordConfirm' })
  async confirmForgotPassword(
    @Body() body: StoreConfirmForgotDto,
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
  @ApiOperation({ operationId: 'storeAuthSession' })
  async session(@Res({ passthrough: true }) reply: FastifyReply): Promise<unknown> {
    const sessionId = readSessionCookie(reply.request.headers.cookie, STORE_SESSION_COOKIE);
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
        storeSessionCookie(
          context.rotation.session.sessionId,
          new Date(context.rotation.session.expiresAt),
          { secure: cookieSecure(reply.request) },
        ),
      );
    return {
      manager: await this.managerView(context.principal.userId, context.identity),
      csrfToken: context.csrfToken,
      idleExpiresAt: await this.idleExpiresAt(context.sessionId),
    };
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ operationId: 'storeAuthLogout' })
  async logout(
    @Body() body: StoreLogoutDto,
    @Headers(STORE_CSRF_HEADER) csrf: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const request = reply.request;
    assertAllowedOrigin(request, this.allowedOrigins);
    const sessionId = readSessionCookie(request.headers.cookie, STORE_SESSION_COOKIE);
    if (!sessionId) throw new UnauthorizedException({ code: 'SESSION_EXPIRED' });
    if (!(await this.sessions.verifyCsrf(sessionId, csrf ?? '')))
      throw new ForbiddenException({ code: 'CSRF_TOKEN_INVALID' });
    if (body.allSessions) {
      const session = await this.sessions.resolve(sessionId);
      await this.sessions.revokeAllForUser(session.userId);
    } else await this.sessions.revoke(sessionId);
    reply.header(
      'set-cookie',
      storeSessionCookie('', new Date(0), { clear: true, secure: cookieSecure(request) }),
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

  private async idleExpiresAt(sessionId: string): Promise<string> {
    const live = await this.sessions.resolve(sessionId);
    return live.idleExpiresAt;
  }

  /** Verifies the provider tokens, authorizes the store audience and enforces STORE_MANAGER. */
  private async establish(tokens: AuthTokens) {
    const identity = await this.verifier.verify(tokens.accessToken, 'store', 'access');
    const principal = await this.identities.authorize(identity, 'store');
    if (!principal.roles.includes('STORE_MANAGER'))
      throw new ForbiddenException({ code: 'FORBIDDEN' });
    const provider: AdminSessionProvider =
      this.config.get('AUTH_PROVIDER') === 'local' ? 'local' : 'cognito';
    const session = await this.sessions.create(principal.userId, provider, tokens);
    return { session, manager: await this.managerView(principal.userId, identity) };
  }

  /** Access tokens carry no profile claims — resolve email/name/assignments from the database. */
  private async managerView(userId: string, identity: { email?: string; name?: string }) {
    const profile = await this.profiles.get(userId).catch(() => null);
    const stores = await this.access.listStoreAssignments(userId).catch(() => []);
    return {
      userId,
      email: profile?.email || identity.email || '',
      name: profile?.name || identity.name || '',
      role: 'STORE_MANAGER',
      stores,
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

function setStoreSessionCookie(
  reply: FastifyReply,
  sessionId: string,
  expiresAt: string,
  browserSession = false,
): void {
  reply.header(
    'set-cookie',
    storeSessionCookie(sessionId, new Date(expiresAt), {
      secure: cookieSecure(reply.request),
      browserSession,
    }),
  );
}
