import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  ServiceUnavailableException,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  CATALOG_MEDIA,
  MEDIA_STORAGE,
  type CatalogMedia,
  type StoragePort,
} from '../../modules/media/contracts/storage.js';
@ApiExcludeController()
@Controller()
export class CatalogMediaController {
  constructor(
    @Inject(CATALOG_MEDIA) private readonly media: CatalogMedia,
    @Inject(MEDIA_STORAGE) private readonly storage: StoragePort,
  ) {}
  @Put('dev/catalog-media/:id') async upload(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('authorization') auth: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    if (!this.storage.upload) throw new NotFoundException();
    const token = /^Bearer (\S+)$/.exec(auth ?? '')?.[1];
    if (!token) throw new NotFoundException();
    try {
      await this.storage.upload(id, token, request.body as Buffer);
    } catch {
      throw new NotFoundException();
    }
  }
  @Get('media/:id') async read(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() reply: FastifyReply,
  ) {
    try {
      const media = await this.media.publicRead(id);
      await reply
        .type(media.contentType)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(media.body);
    } catch (error) {
      if (error instanceof Error && error.message === 'ExternalServiceUnavailable')
        throw new ServiceUnavailableException({ code: 'ExternalServiceUnavailable' });
      throw new NotFoundException();
    }
  }
}
