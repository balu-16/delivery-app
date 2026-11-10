import { Module } from '@nestjs/common';
import { MediaModule } from '../../modules/media/media.module.js';
import { CatalogMediaController } from './media.controller.js';
import { PrivateObjectsController } from './private-objects.controller.js';
@Module({ imports: [MediaModule], controllers: [CatalogMediaController, PrivateObjectsController] })
export class CatalogMediaSurfaceModule {}
