import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { CatalogImportsModule } from '../../../modules/catalog/catalog.module.js';
import { AdminCatalogImportController } from './import.controller.js';
@Module({
  imports: [IdentityModule, CatalogImportsModule],
  controllers: [AdminCatalogImportController],
})
export class AdminCatalogImportSurfaceModule {}
