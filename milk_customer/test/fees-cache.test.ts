/// <reference types="jest" />
import { customerApi } from '../src/api/customer';
import {
  clearFeesCache, FEES_CACHE_TTL_MS, feeBandTotalPaise, fetchDeliverySettings,
  getCachedDeliverySettings, isDeliverySettingsFresh, lookupFeeBand, setCachedDeliverySettings,
} from '../src/store/fees-cache';

jest.mock('../src/api/customer', () => ({
  customerApi: { deliverySettings: jest.fn() },
}));
const api = jest.mocked(customerApi);
const band = (upToSubtotalPaise: string | null, deliveryPaise = '1000') => ({
  upToSubtotalPaise, deliveryPaise, handlingPaise: '200', smallCartPaise: '0', surgePaise: '0',
});
const settings = (revision = '1') => ({
  locationRequired: false,
  feeEstimate: { revision, bands: [band('50000'), band(null, '0')] },
});

beforeEach(() => {
  jest.clearAllMocks();
  clearFeesCache();
});

test('shares one cached entry per account for 60 seconds', () => {
  expect(FEES_CACHE_TTL_MS).toBe(60_000);
  setCachedDeliverySettings('user-1', settings());
  expect(getCachedDeliverySettings('user-1')?.settings.feeEstimate?.revision).toBe('1');
  expect(getCachedDeliverySettings('user-2')).toBeUndefined();
  const now = Date.now();
  expect(isDeliverySettingsFresh({ settings: settings(), fetchedAt: now - 59_999 }, now)).toBe(true);
  expect(isDeliverySettingsFresh({ settings: settings(), fetchedAt: now - 60_000 }, now)).toBe(false);
});

test('deduplicates concurrent fetches and caches the reply', async () => {
  let finish!: (value: ReturnType<typeof settings>) => void;
  api.deliverySettings.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const first = fetchDeliverySettings('user-1', 'token');
  const second = fetchDeliverySettings('user-1', 'token');
  expect(api.deliverySettings).toHaveBeenCalledTimes(1);
  expect(api.deliverySettings).toHaveBeenCalledWith('token');
  finish(settings('7'));
  await expect(first).resolves.toMatchObject({ locationRequired: false });
  await expect(second).resolves.toMatchObject({ locationRequired: false });
  expect(getCachedDeliverySettings('user-1')?.settings.feeEstimate?.revision).toBe('7');
});

test('does not cache failures, and clears one account without touching another', async () => {
  api.deliverySettings.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(settings('2'));
  await expect(fetchDeliverySettings('user-1', 'token')).rejects.toThrow('offline');
  await expect(fetchDeliverySettings('user-1', 'token')).resolves.toMatchObject({ locationRequired: false });
  expect(api.deliverySettings).toHaveBeenCalledTimes(2);
  setCachedDeliverySettings('user-2', settings('9'));
  clearFeesCache('user-1');
  expect(getCachedDeliverySettings('user-1')).toBeUndefined();
  expect(getCachedDeliverySettings('user-2')?.settings.feeEstimate?.revision).toBe('9');
});

test('looks up bands by inclusive ceiling with a null final band', () => {
  const bands = [band('50000'), band('100000', '500'), band(null, '0')];
  expect(lookupFeeBand(bands, '1000')).toBe(bands[0]);
  expect(lookupFeeBand(bands, '50000')).toBe(bands[0]);
  expect(lookupFeeBand(bands, '50001')).toBe(bands[1]);
  expect(lookupFeeBand(bands, '999999999')).toBe(bands[2]);
  expect(lookupFeeBand([], '1000')).toBeNull();
  expect(lookupFeeBand(bands, 'not-money')).toBeNull();
});

test('totals one band across delivery, handling, small-cart, and surge', () => {
  expect(feeBandTotalPaise({ upToSubtotalPaise: '50000', deliveryPaise: '1000', handlingPaise: '200', smallCartPaise: '300', surgePaise: '400' })).toBe('1900');
});
