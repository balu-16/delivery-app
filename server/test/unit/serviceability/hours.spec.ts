import { isStoreOpenAt } from '../../../src/modules/stores/domain/hours.js';
import type { StoreSchedule } from '../../../src/modules/stores/contracts/schedule.js';
import { ensureAddressChangeAllowed } from '../../../src/modules/serviceability/domain/address-change.js';
import { validateAddress } from '../../../src/modules/addresses/domain/address.js';

const schedule: StoreSchedule = {
  timezone: 'Asia/Kolkata',
  weekly: { 1: [{ startMinute: 22 * 60, endMinute: 2 * 60 }] },
  holidays: {},
  lastOrderBufferMinutes: 30,
};
describe('store hours and address rules', () => {
  it('includes an overnight window until the exact last-order buffer', () => {
    expect(isStoreOpenAt(schedule, new Date('2026-11-02T16:30:00Z'))).toBe(true); // Monday 22:00 IST
    expect(isStoreOpenAt(schedule, new Date('2026-11-02T19:59:59Z'))).toBe(true); // Tuesday 01:29:59 IST
    expect(isStoreOpenAt(schedule, new Date('2026-11-02T20:00:00Z'))).toBe(false);
  });
  it('treats a closed holiday as closed across an overnight window', () => {
    expect(
      isStoreOpenAt(
        { ...schedule, holidays: { '2026-11-03': { closed: true, windows: [] } } },
        new Date('2026-11-02T19:00:00Z'),
      ),
    ).toBe(false);
  });
  it('honours a holiday replacement schedule', () => {
    const withHoliday = {
      ...schedule,
      holidays: {
        '2026-11-03': { closed: false, windows: [{ startMinute: 600, endMinute: 720 }] },
      },
    };
    expect(isStoreOpenAt(withHoliday, new Date('2026-11-03T05:00:00Z'))).toBe(true);
    expect(isStoreOpenAt(withHoliday, new Date('2026-11-03T06:00:00Z'))).toBe(false);
  });
  it('requires a valid address, contact and India coordinates', () => {
    const valid = {
      line1: '1 Market Road',
      pincode: '560001',
      contactName: 'Test',
      contactPhone: '+919876543210',
      point: { lat: 12.97, lng: 77.59 },
    };
    expect(() => validateAddress(valid)).not.toThrow();
    for (const input of [
      { ...valid, pincode: '56001' },
      { ...valid, contactPhone: '98765' },
      { ...valid, point: { lat: 0, lng: 0 } },
    ])
      expect(() => validateAddress(input)).toThrow();
  });
  it('only allows pre-pick changes in the same zone for the same fee', () => {
    const value = {
      status: 'CONFIRMED',
      originalZoneId: 'a',
      newZoneId: 'a',
      originalDeliveryFeePaise: 100n,
      newDeliveryFeePaise: 100n,
    };
    expect(() => ensureAddressChangeAllowed(value)).not.toThrow();
    for (const change of [{ status: 'PICKING' }, { newZoneId: 'b' }, { newDeliveryFeePaise: 101n }])
      expect(() => ensureAddressChangeAllowed({ ...value, ...change })).toThrow(
        'ADDRESS_CHANGE_NOT_ALLOWED',
      );
  });
});
