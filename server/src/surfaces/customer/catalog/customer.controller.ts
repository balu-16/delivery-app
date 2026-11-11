import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Query,
  Put,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import type { CatalogPageOptions } from '../../../modules/catalog/contracts/catalog.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { SEARCH_PORT, type SearchPort } from '../../../modules/catalog/contracts/search.js';
import { CATALOG_QUERY, type CatalogQuery } from '../../../modules/catalog/contracts/catalog.js';
class BrowseQuery {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() addressId?: string;
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ maxLength: 4096 })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  cursor?: string;
}
function page(q: BrowseQuery): CatalogPageOptions {
  return {
    ...(q.limit === undefined ? {} : { limit: q.limit }),
    ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
  };
}
class SearchQuery extends BrowseQuery {
  @ApiProperty({ maxLength: 64 }) @IsString() @MaxLength(64) q!: string;
}
class ItemView {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ format: 'uuid' }) categoryId!: string;
  @ApiProperty({ type: String, nullable: true }) brandId!: string | null;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() variantName!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() sellingPaise!: string;
  @ApiProperty() mrpPaise!: string;
  @ApiProperty() discountPercent!: number;
  @ApiProperty({ enum: ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK'] }) availability!: string;
  @ApiPropertyOptional() remaining?: string;
  @ApiProperty() maxPerOrder!: number;
  @ApiProperty({ type: String, isArray: true }) images!: string[];
}
class CatalogPageView {
  @ApiProperty({ type: ItemView, isArray: true }) items!: ItemView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
class CategoryView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}
class CategoryListView {
  @ApiProperty({ type: CategoryView, isArray: true }) items!: CategoryView[];
}
class FavoritesQuery {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
}
class FavoritesPageView {
  @ApiProperty({ type: String, isArray: true, format: 'uuid' }) items!: string[];
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) nextCursor!: string | null;
}
@Controller('v1/customer')
@ApiBearerAuth()
@AuthPolicy({ audience: 'customer' })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class CustomerCatalogController {
  constructor(
    @Inject(CATALOG_QUERY) private readonly catalog: CatalogQuery,
    @Inject(SEARCH_PORT) private readonly searchPort: SearchPort,
  ) {}
  private async read(
    principal: Principal,
    address: string | undefined,
    options: CatalogPageOptions & {
      category?: string;
      product?: string;
      q?: string;
      suggest?: boolean;
      favorites?: boolean;
    },
    tag: string | undefined,
    reply: FastifyReply,
  ) {
    const page: CatalogPageOptions = {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    };
    const result =
      options.q === undefined
        ? await this.catalog.list(principal.userId, address, options)
        : options.suggest
          ? await this.searchPort.suggest(principal.userId, address, options.q, page)
          : await this.searchPort.searchProducts(principal.userId, address, options.q, page);
    reply.header('Cache-Control', 'private, no-cache').header('ETag', result.etag);
    if (tag === result.etag) {
      reply.status(304);
      return;
    }
    return { items: result.items, nextCursor: result.nextCursor };
  }
  @Get('catalog/home')
  @ApiOperation({ operationId: 'customerCatalogHome' })
  @ApiOkResponse({ type: CatalogPageView })
  home(
    @CurrentPrincipal() p: Principal,
    @Query() q: BrowseQuery,
    @Headers('if-none-match') tag: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.read(p, q.addressId, { ...page(q) }, tag, reply);
  }
  @Get('catalog/categories')
  @ApiOperation({ operationId: 'customerCatalogCategories' })
  @ApiOkResponse({ type: CategoryListView })
  async categories(@CurrentPrincipal() p: Principal, @Query() q: BrowseQuery) {
    return { items: await this.catalog.categories(p.userId, q.addressId) };
  }
  @Get('favorites')
  @ApiOperation({ operationId: 'customerFavoritesList' })
  @ApiOkResponse({ type: FavoritesPageView })
  favorites(@CurrentPrincipal() p: Principal, @Query() q: FavoritesQuery) {
    return this.catalog.favorites(p.userId, q.cursor);
  }
  @Get('favorites/products')
  @ApiOperation({ operationId: 'customerFavoritesProducts' })
  @ApiOkResponse({ type: CatalogPageView })
  favoriteProducts(
    @CurrentPrincipal() p: Principal,
    @Query() q: BrowseQuery,
    @Headers('if-none-match') tag: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.read(p, q.addressId, { favorites: true, ...page(q) }, tag, reply);
  }
  @Put('favorites/:id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'customerFavoriteAdd' })
  addFavorite(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.setFavorite(p.userId, id, true);
  }
  @Delete('favorites/:id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'customerFavoriteRemove' })
  removeFavorite(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.setFavorite(p.userId, id, false);
  }
  @Get('catalog/categories/:id/products')
  @ApiOperation({ operationId: 'customerCatalogCategory' })
  @ApiOkResponse({ type: CatalogPageView })
  category(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() q: BrowseQuery,
    @Headers('if-none-match') tag: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.read(p, q.addressId, { category: id, ...page(q) }, tag, reply);
  }
  @Get('catalog/products/:id')
  @ApiOperation({ operationId: 'customerCatalogProduct' })
  @ApiOkResponse({ type: CatalogPageView })
  product(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() q: BrowseQuery,
    @Headers('if-none-match') tag: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.read(p, q.addressId, { product: id, ...page(q) }, tag, reply);
  }
  @Get('search')
  @ApiOperation({ operationId: 'customerCatalogSearch' })
  @ApiOkResponse({ type: CatalogPageView })
  search(
    @CurrentPrincipal() p: Principal,
    @Query() q: SearchQuery,
    @Headers('if-none-match') tag: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.read(p, q.addressId, { q: q.q, ...page(q) }, tag, reply);
  }
  @Get('search/suggest')
  @ApiOperation({ operationId: 'customerCatalogSuggest' })
  @ApiOkResponse({ type: CatalogPageView })
  suggest(
    @CurrentPrincipal() p: Principal,
    @Query() q: SearchQuery,
    @Headers('if-none-match') tag: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.read(p, q.addressId, { q: q.q, suggest: true, ...page(q) }, tag, reply);
  }
}
