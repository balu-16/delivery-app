import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';
import { ConfigService } from '../../../config/config.service.js';
import { LocalTokenAdapter } from '../../../adapters/auth/local.js';
import {
  TOKEN_VERIFIER,
  type Audience,
  type Pool,
  type TokenUse,
  type TokenVerifier,
} from '../../../modules/identity/contracts/identity.js';
class TokenDto {
  @IsIn(['CUSTOMER', 'WORKFORCE']) pool!: Pool;
  @IsString() @Length(1, 128) sub!: string;
  @IsIn(['customer', 'rider', 'store', 'admin']) audience!: Audience;
  @IsIn(['id', 'access']) tokenUse!: TokenUse;
}
@ApiExcludeController()
@Controller('dev/auth')
export class DevAuthController {
  constructor(
    private readonly config: ConfigService,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}
  @Post('token') async token(@Body() body: TokenDto): Promise<{ token: string }> {
    if (
      this.config.get('NODE_ENV') === 'production' ||
      this.config.get('AUTH_PROVIDER') !== 'local' ||
      !(this.verifier instanceof LocalTokenAdapter)
    )
      throw new NotFoundException();
    try {
      return {
        token: await this.verifier.issue(body.pool, body.sub, body.audience, body.tokenUse),
      };
    } catch {
      throw new BadRequestException();
    }
  }
}
