import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { IdentityProviderError } from '../../../modules/identity/contracts/identity.js';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiQuery, ApiResponse } from '@nestjs/swagger';
import {
  ConfigSnapshotResponseDto,
  ProblemDto,
  RequestIdResponseDto,
  UrlResponseDto,
  WorkforceResponseDto,
} from '../../../modules/identity/contracts/swagger.js';
import { IsBoolean, IsDefined, IsEmail, IsIn, IsString, Length } from 'class-validator';
import {
  ADMIN_CONFIG,
  FEATURE_FLAG_KEYS,
  type AdminConfig,
  type ConfigKey,
  type FeatureFlagKey,
} from '../../../modules/app-config/contracts/config.js';
import { ZodError } from 'zod';
import {
  RIDER_DOCUMENTS,
  type RiderDocuments,
} from '../../../modules/identity/contracts/uploads.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import {
  IDENTITY_ADMINISTRATION,
  WORKFORCE_PROVISIONER,
  type IdentityAdministration,
  type Principal,
  type Role,
  type WorkforceProvisioner,
} from '../../../modules/identity/contracts/identity.js';
async function identityCommand<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    if (error instanceof ZodError) throw new BadRequestException({ code: 'INVALID_CONFIG_VALUE' });
    if (error instanceof IdentityProviderError) {
      if (error.code === 'ExternalServiceRejected')
        throw new BadGatewayException({ code: error.code });
      throw new ServiceUnavailableException({ code: error.code });
    }
    const code = error instanceof Error ? error.message : '';
    if (code === 'FORBIDDEN' || code === 'ACCOUNT_DISABLED')
      throw new ForbiddenException({ code: 'FORBIDDEN' });
    if (
      [
        'APPROVAL_INVALID',
        'APPROVAL_POLICY_CHANGED',
        'LAST_SUPER_ADMIN',
        'CANNOT_DISABLE_SELF',
        'PROVISIONING_INPUT_CONFLICT',
        'ROLE_NOT_ASSIGNED',
        'DOCUMENT_STATE_INVALID',
      ].includes(code)
    )
      throw new ConflictException({ code });
    if (
      [
        'INVALID_APPROVAL',
        'INVALID_WORKFORCE_INPUT',
        'ROLE_NOT_MANAGED',
        'INVALID_SEARCH',
        'INVALID_CONFIG_KEY',
        'INVALID_FLAG',
        'REVIEW_REASON_REQUIRED',
      ].includes(code)
    )
      throw new BadRequestException({ code });
    if (['STORE_NOT_FOUND', 'DOCUMENT_NOT_FOUND'].includes(code))
      throw new NotFoundException({ code });
    throw error;
  }
}
class ReviewDto {
  @ApiProperty() @IsBoolean() approved!: boolean;
  @ApiProperty({ maxLength: 500 }) @IsString() @Length(0, 500) reason!: string;
}
class WorkforceDto {
  @ApiProperty({ format: 'email', minLength: 3, maxLength: 254 })
  @IsEmail()
  @Length(3, 254)
  email!: string;
  @ApiProperty({ minLength: 1, maxLength: 100 }) @IsString() @Length(1, 100) name!: string;
  @ApiProperty({ enum: ['RIDER', 'PICKER', 'STORE_MANAGER', 'SUPPORT_AGENT', 'ADMIN'] })
  @IsIn(['RIDER', 'PICKER', 'STORE_MANAGER', 'SUPPORT_AGENT', 'ADMIN'])
  role!: Role;
}
class BlockDto {
  @ApiProperty() @IsBoolean() blocked!: boolean;
}
class RoleChangeDto {
  @ApiProperty({
    enum: ['RIDER', 'PICKER', 'STORE_MANAGER', 'SUPPORT_AGENT', 'ADMIN', 'SUPER_ADMIN'],
  })
  @IsIn(['RIDER', 'PICKER', 'STORE_MANAGER', 'SUPPORT_AGENT', 'ADMIN', 'SUPER_ADMIN'])
  role!: Role;
  @ApiProperty() @IsBoolean() grant!: boolean;
}
class StoreAssignmentDto {
  @ApiProperty({ enum: ['PICKER', 'STORE_MANAGER'] }) @IsIn(['PICKER', 'STORE_MANAGER']) role!:
    'PICKER' | 'STORE_MANAGER';
  @ApiProperty() @IsBoolean() grant!: boolean;
}
class ConfigUpdateDto {
  @ApiProperty({ description: 'Typed value for the selected configuration key' })
  @IsDefined()
  value!: unknown;
}
class FlagUpdateDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
}
class AdminUserDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['CUSTOMER', 'WORKFORCE'] }) pool!: string;
  @ApiProperty({ enum: ['ACTIVE', 'BLOCKED', 'DELETED'] }) status!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
}
class AdminUserPageDto {
  @ApiProperty({ type: [AdminUserDto] }) users!: AdminUserDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
@ApiBearerAuth()
@ApiResponse({ status: 400, type: ProblemDto, description: 'Invalid request' })
@ApiResponse({ status: 401, type: ProblemDto, description: 'Missing or invalid access token' })
@ApiResponse({ status: 403, type: ProblemDto, description: 'Account or role is not permitted' })
@ApiResponse({ status: 404, type: ProblemDto, description: 'Resource not found' })
@ApiResponse({ status: 409, type: ProblemDto, description: 'State or approval conflict' })
@ApiResponse({ status: 503, type: ProblemDto, description: 'Provider unavailable' })
@Controller('v1/admin')
@AuthPolicy({ audience: 'admin', roles: ['ADMIN', 'SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
export class AdminIdentityController {
  constructor(
    @Inject(WORKFORCE_PROVISIONER) private readonly workforce: WorkforceProvisioner,
    @Inject(IDENTITY_ADMINISTRATION) private readonly administration: IdentityAdministration,
    @Inject(RIDER_DOCUMENTS) private readonly documents: RiderDocuments | null,
    @Inject(ADMIN_CONFIG) private readonly config: AdminConfig,
  ) {}
  @Get('config')
  @ApiResponse({ status: 200, type: ConfigSnapshotResponseDto })
  @AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
  async getConfig() {
    return this.config.snapshot();
  }
  @Post('config/:key')
  @ApiResponse({ status: 201, description: 'Setting updated; empty response' })
  @AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
  async updateConfig(
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
    @Body() body: ConfigUpdateDto,
  ): Promise<void> {
    await identityCommand(() => this.config.update(principal.userId, key as ConfigKey, body.value));
  }
  @Post('feature-flags/:key')
  @ApiResponse({ status: 201, description: 'Flag updated; empty response' })
  @AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
  async updateFlag(
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
    @Body() body: FlagUpdateDto,
  ): Promise<void> {
    if (!(FEATURE_FLAG_KEYS as readonly string[]).includes(key))
      throw new BadRequestException({ code: 'INVALID_FLAG' });
    await identityCommand(() =>
      this.config.setFlag(principal.userId, key as FeatureFlagKey, body.enabled),
    );
  }
  @Get('users')
  @ApiOkResponse({ type: AdminUserPageDto })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'before',
    required: false,
    type: String,
    description: 'Cursor from the previous page',
  })
  async listUsers(
    @CurrentPrincipal() principal: Principal,
    @Query('search') search = '',
    @Query('before') before?: string,
  ) {
    return identityCommand(() => this.administration.listUsers(principal.userId, search, before));
  }
  @Get('rider-documents/:documentId/read-url')
  @ApiResponse({ status: 200, type: UrlResponseDto })
  async readDocument(
    @CurrentPrincipal() principal: Principal,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<{ url: string }> {
    if (!this.documents) throw new ServiceUnavailableException();
    return {
      url: await identityCommand(() => this.documents!.reviewUrl(principal.userId, documentId)),
    };
  }
  @Post('rider-documents/:documentId/review')
  @ApiResponse({ status: 201, description: 'Document reviewed; empty response' })
  async reviewDocument(
    @CurrentPrincipal() principal: Principal,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() body: ReviewDto,
  ): Promise<void> {
    if (!this.documents) throw new ServiceUnavailableException();
    await identityCommand(() =>
      this.documents!.review(principal.userId, documentId, body.approved, body.reason),
    );
  }
  @Post('users/workforce') @ApiResponse({ status: 201, type: WorkforceResponseDto }) async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: WorkforceDto,
  ) {
    return identityCommand(() =>
      this.workforce.provision(principal.userId, body.email, body.name, body.role),
    );
  }
  @Post('users/:userId/block')
  @ApiResponse({ status: 201, description: 'Account state updated; empty response' })
  @AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
  async block(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: BlockDto,
  ): Promise<void> {
    await identityCommand(() =>
      this.administration.setBlocked(principal.userId, userId, body.blocked),
    );
  }
  @Post('users/:userId/password-reset')
  @ApiResponse({ status: 201, description: 'Reset queued; empty response' })
  @AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
  async resetPassword(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await identityCommand(() => this.administration.resetPassword(principal.userId, userId));
  }
  @Post('users/:userId/stores/:storeId')
  @ApiResponse({ status: 201, description: 'Assignment updated; empty response' })
  @AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
  async assignStore(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() body: StoreAssignmentDto,
  ): Promise<void> {
    await identityCommand(() =>
      this.administration.setStoreAssignment(
        principal.userId,
        userId,
        storeId,
        body.role,
        body.grant,
      ),
    );
  }
  @Post('users/:userId/roles/requests')
  @ApiResponse({ status: 201, type: RequestIdResponseDto })
  @AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
  async requestRole(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: RoleChangeDto,
  ): Promise<{ requestId: string }> {
    return {
      requestId: await identityCommand(() =>
        this.administration.requestRoleChange(principal.userId, userId, body.role, body.grant),
      ),
    };
  }
  @Post('role-change-requests/:requestId/approve')
  @ApiResponse({ status: 201, description: 'Approval executed; empty response' })
  @AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
  async approveRole(
    @CurrentPrincipal() principal: Principal,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<void> {
    await identityCommand(() => this.administration.approveRoleChange(principal.userId, requestId));
  }
}
