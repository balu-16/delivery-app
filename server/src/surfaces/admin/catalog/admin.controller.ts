import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiResponse,
} from '@nestjs/swagger';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { CATALOG_ADMIN, type CatalogAdmin } from '../../../modules/catalog/contracts/catalog.js';
import {
  AssortmentDto,
  NameDto,
  PriceDto,
  ProductDto,
  SynonymDto,
  VariantDto,
  PageDto,
  NamedPageView,
  ProductPageView,
  VariantPageView,
  PriceResultView,
  NameView,
  ProductView,
  VariantView,
  SynonymPageDto,
  SynonymPageView,
  VariantsPageDto,
} from './catalog.dto.js';
export class IdView {
  @ApiProperty({ format: 'uuid' }) id!: string;
}
@ApiResponse({ status: 400, description: 'Invalid request' })
@ApiResponse({ status: 401, description: 'Authentication required' })
@ApiResponse({ status: 403, description: 'Insufficient role' })
@ApiResponse({ status: 404, description: 'Resource not found' })
@ApiResponse({ status: 409, description: 'Conflict or approval required' })
@Controller('v1/admin/catalog')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class AdminCatalogController {
  constructor(@Inject(CATALOG_ADMIN) private readonly catalog: CatalogAdmin) {}
  @Get('categories')
  @ApiOperation({ operationId: 'adminListCategories' })
  @ApiOkResponse({ type: NamedPageView })
  categories(@CurrentPrincipal() p: Principal, @Query() q: PageDto) {
    return this.catalog.list(p.userId, 'categories', q.limit ?? 50, q.cursor);
  }
  @Get('categories/:id')
  @ApiOperation({ operationId: 'adminGetCategory' })
  @ApiOkResponse({ type: NameView })
  getCategories(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.get(p.userId, 'categories', id);
  }
  @Post('categories')
  @ApiOperation({ operationId: 'adminCreateCategory' })
  @ApiCreatedResponse({ type: IdView })
  async createCategory(@CurrentPrincipal() p: Principal, @Body() d: NameDto) {
    return { id: await this.catalog.saveNamed(p.userId, 'categories', d.name) };
  }
  @Put('categories/:id')
  @ApiOperation({ operationId: 'adminUpdateCategory' })
  @ApiOkResponse({ type: IdView })
  async updateCategory(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() d: NameDto,
  ) {
    return { id: await this.catalog.saveNamed(p.userId, 'categories', d.name, id) };
  }
  @Delete('categories/:id') @ApiOperation({ operationId: 'adminDeleteCategory' }) deleteCategory(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.catalog.remove(p.userId, 'categories', id);
  }
  @Get('brands')
  @ApiOperation({ operationId: 'adminListBrands' })
  @ApiOkResponse({ type: NamedPageView })
  brands(@CurrentPrincipal() p: Principal, @Query() q: PageDto) {
    return this.catalog.list(p.userId, 'brands', q.limit ?? 50, q.cursor);
  }
  @Get('brands/:id')
  @ApiOperation({ operationId: 'adminGetBrand' })
  @ApiOkResponse({ type: NameView })
  getBrands(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.get(p.userId, 'brands', id);
  }
  @Post('brands')
  @ApiOperation({ operationId: 'adminCreateBrand' })
  @ApiCreatedResponse({ type: IdView })
  async createBrand(@CurrentPrincipal() p: Principal, @Body() d: NameDto) {
    return { id: await this.catalog.saveNamed(p.userId, 'brands', d.name) };
  }
  @Put('brands/:id')
  @ApiOperation({ operationId: 'adminUpdateBrand' })
  @ApiOkResponse({ type: IdView })
  async updateBrand(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() d: NameDto,
  ) {
    return { id: await this.catalog.saveNamed(p.userId, 'brands', d.name, id) };
  }
  @Delete('brands/:id') @ApiOperation({ operationId: 'adminDeleteBrand' }) deleteBrand(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.catalog.remove(p.userId, 'brands', id);
  }
  @Get('products')
  @ApiOperation({ operationId: 'adminListProducts' })
  @ApiOkResponse({ type: ProductPageView })
  products(@CurrentPrincipal() p: Principal, @Query() q: PageDto) {
    return this.catalog.list(p.userId, 'products', q.limit ?? 50, q.cursor);
  }
  @Get('products/:id')
  @ApiOperation({ operationId: 'adminGetProduct' })
  @ApiOkResponse({ type: ProductView })
  getProducts(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.get(p.userId, 'products', id);
  }
  @Post('products')
  @ApiOperation({ operationId: 'adminCreateProduct' })
  @ApiCreatedResponse({ type: IdView })
  async createProduct(@CurrentPrincipal() p: Principal, @Body() d: ProductDto) {
    return { id: await this.catalog.saveProduct(p.userId, d) };
  }
  @Put('products/:id')
  @ApiOperation({ operationId: 'adminUpdateProduct' })
  @ApiOkResponse({ type: IdView })
  async updateProduct(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() d: ProductDto,
  ) {
    return { id: await this.catalog.saveProduct(p.userId, d, id) };
  }
  @Delete('products/:id') @ApiOperation({ operationId: 'adminDeleteProduct' }) deleteProduct(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.catalog.remove(p.userId, 'products', id);
  }
  @Post('products/:id/publish') @ApiOperation({ operationId: 'adminPublishProduct' }) publish(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.catalog.publish(p.userId, id, true);
  }
  @Post('products/:id/unpublish') @ApiOperation({ operationId: 'adminUnpublishProduct' }) unpublish(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.catalog.publish(p.userId, id, false);
  }
  @Get('variants')
  @ApiOperation({ operationId: 'adminListVariants' })
  @ApiOkResponse({ type: VariantPageView })
  variants(@CurrentPrincipal() p: Principal, @Query() q: VariantsPageDto) {
    return this.catalog.list(p.userId, 'variants', q.limit ?? 50, q.cursor, undefined, q.productId);
  }
  @Get('variants/:id')
  @ApiOperation({ operationId: 'adminGetVariant' })
  @ApiOkResponse({ type: VariantView })
  getVariants(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.get(p.userId, 'variants', id);
  }
  @Post('variants')
  @ApiOperation({ operationId: 'adminCreateVariant' })
  @ApiCreatedResponse({ type: IdView })
  async createVariant(@CurrentPrincipal() p: Principal, @Body() d: VariantDto) {
    return { id: await this.catalog.saveVariant(p.userId, d) };
  }
  @Put('variants/:id')
  @ApiOperation({ operationId: 'adminUpdateVariant' })
  @ApiOkResponse({ type: IdView })
  async updateVariant(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() d: VariantDto,
  ) {
    return { id: await this.catalog.saveVariant(p.userId, d, id) };
  }
  @Delete('variants/:id') @ApiOperation({ operationId: 'adminDeleteVariant' }) deleteVariant(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.catalog.remove(p.userId, 'variants', id);
  }
  @Post('assortment') @ApiOperation({ operationId: 'adminAddAssortment' }) assortment(
    @CurrentPrincipal() p: Principal,
    @Body() d: AssortmentDto,
  ) {
    return this.catalog.setAssortment(p.userId, d.storeId, d.variantId);
  }
  @Post('prices')
  @ApiOperation({ operationId: 'adminSetPrice' })
  @ApiCreatedResponse({ type: PriceResultView })
  price(@CurrentPrincipal() p: Principal, @Body() d: PriceDto) {
    return this.catalog.setPrice(p.userId, d);
  }
  @Post('approvals/:id/approve')
  @ApiOperation({ operationId: 'adminApproveCatalogChange' })
  approve(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.approve(p.userId, id);
  }
  @Get('synonyms')
  @ApiOperation({ operationId: 'adminListSynonyms' })
  @ApiOkResponse({ type: SynonymPageView })
  synonyms(@CurrentPrincipal() p: Principal, @Query() q: SynonymPageDto) {
    return this.catalog.listSynonyms(p.userId, q.limit ?? 50, q.cursor);
  }
  @Put('synonyms') @ApiOperation({ operationId: 'adminSetSynonym' }) synonym(
    @CurrentPrincipal() p: Principal,
    @Body() d: SynonymDto,
  ) {
    return this.catalog.synonym(p.userId, d.term, d.expansion);
  }
}
