import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LocalPrivateUploads } from '../../../adapters/storage/local-private.js';
import { PRIVATE_UPLOADS } from '../../../modules/identity/contracts/uploads.js';
@ApiExcludeController()
@Controller('dev/private-media')
export class PrivateMediaController {
  constructor(@Inject(PRIVATE_UPLOADS) private readonly storage: LocalPrivateUploads | null) {}
  @Put(':mediaId') async upload(
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    if (!this.storage) throw new ServiceUnavailableException();
    const match = /^Bearer (\S+)$/.exec(authorization ?? '');
    if (!match?.[1]) throw new NotFoundException();
    try {
      await this.storage.upload(mediaId, match[1], request.body as Buffer);
    } catch {
      throw new NotFoundException();
    }
  }
  @Get(':mediaId') async read(
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
    @Query('capability') capability: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!this.storage) throw new ServiceUnavailableException();
    try {
      const media = await this.storage.read(mediaId, capability);
      await reply
        .type(media.contentType)
        .header('cache-control', 'private, no-store')
        .header('content-disposition', 'attachment')
        .send(media.body);
    } catch {
      throw new NotFoundException();
    }
  }
}
