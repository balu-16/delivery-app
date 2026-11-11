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
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
} from '@nestjs/swagger';
import {
  PrincipalResponseDto,
  ProblemDto,
  ProfileResponseDto,
  RequestIdResponseDto,
} from '../../../modules/identity/contracts/swagger.js';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { REFERRALS, type Referrals } from '../../../modules/referrals/contracts/referrals.js';
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
class BootstrapDto {
  @ApiPropertyOptional({ pattern: '^[A-Fa-f0-9]{16}$' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Fa-f0-9]{16}$/)
  referralCode?: string;
}
class ReferralViewDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) code!: string | null;
  @ApiProperty() successfulReferrals!: number;
  @ApiProperty() rewardPaise!: string;
  @ApiProperty() freeDeliveryAvailable!: boolean;
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
        'INVALID_REFERRAL_CODE',
        'REFERRAL_SIGNUP_ONLY',
      ].includes(code)
    )
      throw new BadRequestException({ code });
    if (code === 'ACCOUNT_DISABLED' || code === 'EMAIL_NOT_VERIFIED')
      throw new ForbiddenException({ code });
    if (code === 'REFERRALS_UNAVAILABLE') throw new ServiceUnavailableException({ code });
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
    @Inject(REFERRALS) private readonly referrals: Referrals,
  ) {}
  @Post('auth/bootstrap')
  @ApiResponse({ status: 201, type: PrincipalResponseDto })
  @AuthPolicy({ audience: 'customer', tokenUse: 'id', bootstrap: true })
  async bootstrap(
    @Req() request: AuthenticatedRequest,
    @Body() body?: BootstrapDto,
  ): Promise<Principal> {
    return customerCommand(() => this.identity.bootstrap(request.identity!, body?.referralCode));
  }
  @Get('referrals')
  @ApiOperation({ operationId: 'customerReferrals' })
  @ApiResponse({ status: 200, type: ReferralViewDto })
  async referral(@CurrentPrincipal() principal: Principal) {
    return customerCommand(() => this.referrals.view(principal.userId));
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
