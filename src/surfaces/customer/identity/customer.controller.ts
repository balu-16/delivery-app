import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import {
  PrincipalResponseDto,
  ProblemDto,
  ProfileResponseDto,
  RequestIdResponseDto,
} from '../../../modules/identity/contracts/swagger.js';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import {
  AuthPolicy,
  CurrentPrincipal,
  type AuthenticatedRequest,
} from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import {
  IDENTITY_AUTHORIZER,
  USER_PROFILES,
  type IdentityAuthorizer,
  type Principal,
  type UserProfiles,
} from '../../../modules/identity/contracts/identity.js';
class ProfileDto {
  @ApiProperty({ minLength: 1, maxLength: 100 }) @IsString() @Length(1, 100) name!: string;
  @ApiPropertyOptional({ enum: ['en', 'hi', 'te'] })
  @IsOptional()
  @IsIn(['en', 'hi', 'te'])
  locale?: string;
}
class ConsentDto {
  @ApiProperty({ enum: ['terms', 'privacy'] }) @IsIn(['terms', 'privacy']) type!:
    'terms' | 'privacy';
  @ApiProperty({ minLength: 1, maxLength: 40 }) @IsString() @Length(1, 40) version!: string;
}
async function customerCommand<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message : '';
    if (
      [
        'INVALID_BOOTSTRAP_IDENTITY',
        'INVALID_EMAIL',
        'INVALID_PROFILE',
        'INVALID_CONSENT_VERSION',
      ].includes(code)
    )
      throw new BadRequestException({ code });
    if (code === 'ACCOUNT_DISABLED') throw new ForbiddenException({ code });
    throw error;
  }
}
@ApiBearerAuth()
@ApiResponse({ status: 400, type: ProblemDto, description: 'Invalid request' })
@ApiResponse({ status: 401, type: ProblemDto, description: 'Missing or invalid token' })
@ApiResponse({ status: 403, type: ProblemDto, description: 'Profile or account not permitted' })
@Controller('v1/customer')
@AuthPolicy({ audience: 'customer' })
@UseGuards(IdentityGuard)
export class CustomerIdentityController {
  constructor(
    @Inject(IDENTITY_AUTHORIZER) private readonly identity: IdentityAuthorizer,
    @Inject(USER_PROFILES) private readonly profiles: UserProfiles,
  ) {}
  @Post('auth/bootstrap')
  @ApiResponse({ status: 201, type: PrincipalResponseDto })
  @AuthPolicy({ audience: 'customer', tokenUse: 'id', bootstrap: true })
  async bootstrap(@Req() request: AuthenticatedRequest): Promise<Principal> {
    return customerCommand(() => this.identity.bootstrap(request.identity!));
  }
  @Get('me') @ApiResponse({ status: 200, type: ProfileResponseDto }) async me(
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.profiles.get(principal.userId);
  }
  @Patch('me')
  @ApiResponse({ status: 200, description: 'Profile updated; empty response' })
  async update(@CurrentPrincipal() principal: Principal, @Body() body: ProfileDto): Promise<void> {
    await customerCommand(() => this.profiles.update(principal.userId, body.name, body.locale));
  }
  @Post('me/consents')
  @ApiResponse({ status: 201, description: 'Consent accepted; empty response' })
  async consent(
    @CurrentPrincipal() principal: Principal,
    @Body() body: ConsentDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await customerCommand(() =>
      this.identity.acceptConsent(principal.userId, body.type, body.version, request.ip ?? null),
    );
  }
  @Delete('me') @ApiResponse({ status: 200, type: RequestIdResponseDto }) async erase(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ requestId: string }> {
    return { requestId: await this.profiles.requestErasure(principal.userId) };
  }
}
