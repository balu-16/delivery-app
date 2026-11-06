import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { ProblemDto, StoreResponseDto } from '../../../modules/identity/contracts/swagger.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import {
  USER_PROFILES,
  IDENTITY_ACCESS,
  type Principal,
  type UserProfiles,
  type IdentityAccess,
} from '../../../modules/identity/contracts/identity.js';
@ApiBearerAuth()
@ApiResponse({ status: 401, type: ProblemDto, description: 'Missing or invalid token' })
@ApiResponse({ status: 403, type: ProblemDto, description: 'Account or role not permitted' })
@Controller('v1/store')
@AuthPolicy({ audience: 'store' })
@UseGuards(IdentityGuard)
export class StoreIdentityController {
  constructor(
    @Inject(USER_PROFILES) private readonly profiles: UserProfiles,
    @Inject(IDENTITY_ACCESS) private readonly access: IdentityAccess,
  ) {}
  @Get('me') @ApiResponse({ status: 200, type: StoreResponseDto }) async me(
    @CurrentPrincipal() principal: Principal,
  ) {
    return {
      ...(await this.profiles.get(principal.userId)),
      roles: principal.roles,
      stores: await this.access.listStoreAssignments(principal.userId),
    };
  }
}
