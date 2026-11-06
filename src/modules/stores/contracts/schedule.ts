export interface HoursWindow {
  startMinute: number;
  endMinute: number;
}
export interface Holiday {
  closed: boolean;
  windows: HoursWindow[];
}
export interface StoreSchedule {
  weekly: Partial<Record<number, HoursWindow[]>>;
  holidays: Record<string, Holiday>;
  timezone: string;
  lastOrderBufferMinutes: number;
}
export interface StoreAvailability {
  isOpenAt(storeId: string, target: Date): Promise<boolean>;
}
