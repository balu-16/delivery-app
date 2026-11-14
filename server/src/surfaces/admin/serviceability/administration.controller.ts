import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  STORE_ADMINISTRATION,
  type StoreAdministration,
} from '../../../modules/stores/contracts/administration.js';
import {
  CityPageView,
  EntityPageView,
  ResourceIdView,
  StoreOperationsView,
  StoreCodView,
  StorePageView,
  ZonePageView,
} from './administration.views.js';
import {
  CityDto,
  EntityDto,
  HolidayDto,
  HoursDto,
  OperationsQuery,
  PageQuery,
  StaffDto,
  StoreDto,
  StoreCodDto,
} from './administration.dto.js';
async function response<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const pg =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    const status =
      code === 'FORBIDDEN'
        ? 403
        : ['STORE_NOT_FOUND', 'RESOURCE_NOT_FOUND'].includes(code)
          ? 404
          : ['STORE_CITY_IMMUTABLE', 'CONCURRENT_MODIFICATION'].includes(code) ||
              ['23503', '23505'].includes(pg)
            ? 409
            : [
                  'INVALID_HOURS',
                  'INVALID_ZONE_GEOMETRY',
                  'INVALID_COORDINATES',
                  'ZONE_OUTSIDE_BOUNDS_OR_AREA',
                ].includes(code) || ['22007', '22008'].includes(pg)
              ? 400
              : 0;
    if (status) {
      const safeCode = ['23503', '23505'].includes(pg)
        ? 'RESOURCE_CONFLICT'
        : ['22007', '22008'].includes(pg)
          ? 'INVALID_INPUT'
          : code;
      throw new HttpException({ code: safeCode }, status);
    }
    throw error;
  }
}
@Controller('v1/admin')
@ApiBearerAuth()
@ApiResponse({ status: 400, description: 'Invalid input' })
@ApiResponse({ status: 401, description: 'Invalid token' })
@ApiResponse({ status: 403, description: 'Admin role required' })
@ApiResponse({ status: 404, description: 'Resource not found' })
@ApiResponse({ status: 409, description: 'Conflicting or referenced resource' })
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
export class StoreAdministrationController {
  constructor(@Inject(STORE_ADMINISTRATION) private readonly admin: StoreAdministration) {}
  @Get('legal-entities')
  @ApiOkResponse({ type: EntityPageView })
  @ApiOperation({ operationId: 'adminListLegalEntities' })
  entities(@CurrentPrincipal() p: Principal, @Query() q: PageQuery) {
    return response(() => this.admin.list(p.userId, 'legal_entities', q.limit ?? 50, q.cursor));
  }
  @Post('legal-entities')
  @ApiCreatedResponse({ type: ResourceIdView })
  @ApiOperation({ operationId: 'adminCreateLegalEntity' })
  createEntity(@CurrentPrincipal() p: Principal, @Body() b: EntityDto) {
    return response(async () => ({ id: await this.admin.saveEntity(p.userId, b.name) }));
  }
  @Patch('legal-entities/:id')
  @ApiOkResponse({ type: ResourceIdView })
  @ApiOperation({ operationId: 'adminUpdateLegalEntity' })
  updateEntity(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() b: EntityDto,
  ) {
    return response(async () => ({ id: await this.admin.saveEntity(p.userId, b.name, id) }));
  }
  @Delete('legal-entities/:id')
  @ApiOperation({ operationId: 'adminDeleteLegalEntity' })
  deleteEntity(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return response(() => this.admin.delete(p.userId, 'legal_entities', id));
  }
  @Get('cities')
  @ApiOkResponse({ type: CityPageView })
  @ApiOperation({ operationId: 'adminListCities' })
  cities(@CurrentPrincipal() p: Principal, @Query() q: PageQuery) {
    return response(() => this.admin.list(p.userId, 'cities', q.limit ?? 50, q.cursor));
  }
  @Post('cities')
  @ApiCreatedResponse({ type: ResourceIdView })
  @ApiOperation({ operationId: 'adminCreateCity' })
  createCity(@CurrentPrincipal() p: Principal, @Body() b: CityDto) {
    return response(async () => ({ id: await this.admin.saveCity(p.userId, b.name, b.bounds) }));
  }
  @Patch('cities/:id')
  @ApiOkResponse({ type: ResourceIdView })
  @ApiOperation({ operationId: 'adminUpdateCity' })
  updateCity(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() b: CityDto,
  ) {
    return response(async () => ({
      id: await this.admin.saveCity(p.userId, b.name, b.bounds, id),
    }));
  }
  @Delete('cities/:id') @ApiOperation({ operationId: 'adminDeleteCity' }) deleteCity(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return response(() => this.admin.delete(p.userId, 'cities', id));
  }
  @Get('stores')
  @ApiOkResponse({ type: StorePageView })
  @ApiOperation({ operationId: 'adminListStores' })
  stores(@CurrentPrincipal() p: Principal, @Query() q: PageQuery) {
    return response(() => this.admin.list(p.userId, 'stores', q.limit ?? 50, q.cursor));
  }
  @Post('stores')
  @ApiCreatedResponse({ type: ResourceIdView })
  @ApiOperation({ operationId: 'adminCreateStore' })
  createStore(@CurrentPrincipal() p: Principal, @Body() b: StoreDto) {
    return response(async () => ({ id: await this.admin.saveStore(p.userId, b) }));
  }
  @Patch('stores/:id')
  @ApiOkResponse({ type: ResourceIdView })
  @ApiOperation({ operationId: 'adminUpdateStore' })
  updateStore(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() b: StoreDto,
  ) {
    return response(async () => ({ id: await this.admin.saveStore(p.userId, b, id) }));
  }
  @Patch('stores/:id/cod')
  @ApiOkResponse({ type: StoreCodView })
  @ApiOperation({ operationId: 'adminSetStoreCod' })
  setCod(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() b: StoreCodDto,
  ) {
    return response(() => this.admin.setCod(p.userId, id, b.enabled, b.version));
  }
  @Delete('stores/:id') @ApiOperation({ operationId: 'adminDeleteStore' }) deleteStore(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return response(() => this.admin.delete(p.userId, 'stores', id));
  }
  @Get('zones')
  @ApiOkResponse({ type: ZonePageView })
  @ApiOperation({ operationId: 'adminListZones' })
  zones(@CurrentPrincipal() p: Principal, @Query() q: PageQuery) {
    return response(() => this.admin.list(p.userId, 'zones', q.limit ?? 50, q.cursor));
  }
  @Get('stores/:id/operations')
  @ApiOkResponse({ type: StoreOperationsView })
  @ApiOperation({ operationId: 'adminGetStoreOperations' })
  operations(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() q: OperationsQuery,
  ) {
    return response(() =>
      this.admin.operations(p.userId, id, {
        limit: q.limit ?? 50,
        ...(q.holidayCursor === undefined ? {} : { holidayCursor: q.holidayCursor }),
        ...(q.staffCursor === undefined ? {} : { staffCursor: q.staffCursor }),
      }),
    );
  }
  @Put('stores/:id/hours') @ApiOperation({ operationId: 'adminReplaceStoreHours' }) hours(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() b: HoursDto,
  ) {
    return response(() => this.admin.hours(p.userId, id, b.entries));
  }
  @Put('stores/:id/holidays') @ApiOperation({ operationId: 'adminSaveStoreHoliday' }) holiday(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() b: HolidayDto,
  ) {
    return response(() => this.admin.holiday(p.userId, id, b));
  }
  @Delete('stores/:id/holidays/:day')
  @ApiOperation({ operationId: 'adminDeleteStoreHoliday' })
  deleteHoliday(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('day') day: string,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpException({ code: 'BAD_REQUEST' }, 400);
    return response(() => this.admin.deleteHoliday(p.userId, id, day));
  }
  @Put('stores/:id/staff') @ApiOperation({ operationId: 'adminSetStoreStaff' }) staff(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() b: StaffDto,
  ) {
    return response(() => this.admin.assign(p.userId, id, b.userId, b.role, b.active));
  }
}
