import { Controller, Get, Inject, Query, Res, NotFoundException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '../../config/config.service.js';
import { MEDIA_STORAGE, type StoragePort } from '../../modules/media/contracts/storage.js';

/** Local-only bearer capabilities minted after domain ownership checks. */
@Controller('dev/private-objects')
@ApiExcludeController()
export class PrivateObjectsController {
  constructor(
    private readonly config: ConfigService,
    @Inject(MEDIA_STORAGE) private readonly storage: StoragePort,
  ) {}
  @Get()
  async read(@Query('capability') capability: string, @Res() reply: FastifyReply) {
    if (
      this.config.get('NODE_ENV') === 'production' ||
      !this.storage.readCapability ||
      typeof capability !== 'string'
    )
      throw new NotFoundException();
    try {
      const object = await this.storage.readCapability(capability);
      return reply
        .header('Cache-Control', 'no-store')
        .header('Content-Disposition', 'attachment')
        .type(object.contentType)
        .send(object.body);
    } catch {
      throw new NotFoundException();
    }
  }
}
