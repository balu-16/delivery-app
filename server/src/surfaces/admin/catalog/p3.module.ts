import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { CatalogModule } from '../../../modules/catalog/catalog.module.js';
import { AdminCatalogController } from './admin.controller.js';
@Module({ imports: [IdentityModule, CatalogModule], controllers: [AdminCatalogController] })
export class AdminCatalogSurfaceModule {}
