import { ApiProperty } from '@nestjs/swagger';

export class ResourceIdView {
  @ApiProperty({ format: 'uuid' }) id!: string;
}
export class EntityView extends ResourceIdView {
  @ApiProperty() name!: string;
}
export class CityView extends EntityView {
  @ApiProperty({ type: 'object', additionalProperties: true }) bounds!: object;
  @ApiProperty() zone_version!: string;
}
export class StoreView extends EntityView {
  @ApiProperty({ format: 'uuid' }) legal_entity_id!: string;
  @ApiProperty({ format: 'uuid' }) city_id!: string;
  @ApiProperty({ enum: ['ONLINE', 'PAUSED', 'OFFLINE'] }) status!: string;
  @ApiProperty({ type: String, nullable: true }) pause_reason!: string | null;
  @ApiProperty() hourly_capacity!: number;
  @ApiProperty() last_order_buffer_minutes!: number;
  @ApiProperty() lat!: number;
  @ApiProperty() lng!: number;
  @ApiProperty() version!: string;
}
export class AdminZoneView extends EntityView {
  @ApiProperty({ format: 'uuid' }) store_id!: string;
  @ApiProperty() priority!: number;
  @ApiProperty() active!: boolean;
  @ApiProperty() version!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) geometry!: object;
}
export class EntityPageView {
  @ApiProperty({ type: [EntityView] }) items!: EntityView[];
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) nextCursor!: string | null;
}
export class CityPageView {
  @ApiProperty({ type: [CityView] }) items!: CityView[];
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) nextCursor!: string | null;
}
export class StorePageView {
  @ApiProperty({ type: [StoreView] }) items!: StoreView[];
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) nextCursor!: string | null;
}
export class ZonePageView {
  @ApiProperty({ type: [AdminZoneView] }) items!: AdminZoneView[];
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) nextCursor!: string | null;
}
export class HoursView {
  @ApiProperty() weekday!: number;
  @ApiProperty() start_minute!: number;
  @ApiProperty() end_minute!: number;
}
export class HolidayView {
  @ApiProperty({ format: 'date' }) day!: string;
  @ApiProperty() closed!: boolean;
}
export class HolidayHoursView {
  @ApiProperty({ format: 'date' }) day!: string;
  @ApiProperty() start_minute!: number;
  @ApiProperty() end_minute!: number;
}
export class StaffView {
  @ApiProperty({ format: 'uuid' }) user_id!: string;
  @ApiProperty({ enum: ['PICKER', 'STORE_MANAGER'] }) role!: string;
}
export class StoreOperationsView {
  @ApiProperty({ type: [HoursView] }) hours!: HoursView[];
  @ApiProperty({ type: [HolidayView] }) holidays!: HolidayView[];
  @ApiProperty({ type: [HolidayHoursView] }) holidayHours!: HolidayHoursView[];
  @ApiProperty({ type: [StaffView] }) staff!: StaffView[];
  @ApiProperty({ type: String, nullable: true, format: 'date' }) nextHolidayCursor!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'User UUID and role separated by a colon',
  })
  nextStaffCursor!: string | null;
}
