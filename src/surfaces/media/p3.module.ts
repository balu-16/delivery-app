import { Module } from '@nestjs/common';
import { MediaModule } from '../../modules/media/media.module.js';
import { CatalogMediaController } from './media.controller.js';
@Module({ imports: [MediaModule], controllers: [CatalogMediaController] })
export class CatalogMediaSurfaceModule {}
