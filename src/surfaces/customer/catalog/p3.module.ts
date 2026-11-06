import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { CatalogModule } from '../../../modules/catalog/catalog.module.js';
import { CustomerCatalogController } from './customer.controller.js';
@Module({ imports: [IdentityModule, CatalogModule], controllers: [CustomerCatalogController] })
export class CustomerCatalogSurfaceModule {}
