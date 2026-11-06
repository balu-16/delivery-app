import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { MediaModule } from '../../../modules/media/media.module.js';
import { AdminCatalogMediaController } from './media.controller.js';
@Module({ imports: [IdentityModule, MediaModule], controllers: [AdminCatalogMediaController] })
export class AdminCatalogMediaSurfaceModule {}
