export interface ZoneDraft {
  storeId: string;
  name: string;
  geometry: unknown;
  priority: number;
  active: boolean;
}
export interface ZoneVersion {
  id: string;
  version: string;
  cityZoneVersion: string;
}
export interface Zones {
  create(
    draft: ZoneDraft,
    area: { minM2: number; maxM2: number },
    actorId?: string,
  ): Promise<ZoneVersion>;
  update(
    id: string,
    expectedVersion: string,
    draft: ZoneDraft,
    area: { minM2: number; maxM2: number },
    actorId?: string,
  ): Promise<ZoneVersion>;
  deactivate(id: string, expectedVersion: string, actorId: string): Promise<ZoneVersion>;
}
