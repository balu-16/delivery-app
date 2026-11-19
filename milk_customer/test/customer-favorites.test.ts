/// <reference types="jest" />
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError } from '../src/api/client';
import { customerApi } from '../src/api/customer';
import { useCustomer } from '../src/store/customer';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../src/auth/session', () => ({ accessToken: jest.fn(async () => 'token'), restoreSession: jest.fn(async () => true), signOut: jest.fn(async () => {}) }));
jest.mock('../src/api/customer', () => ({
  customerApi: { favorites: jest.fn(), setFavorite: jest.fn() },
  customerDetailsApi: {},
}));
const api = jest.mocked(customerApi);
const profile = { userId: 'user-1', name: 'Customer', email: 'test@example.invalid', locale: null };
const settleFavorites = async () => {
  for (let n = 0; n < 100 && useCustomer.getState().favoriteBusy.length; n++) await new Promise(resolve => setTimeout(resolve, 0));
};

beforeEach(async () => {
  await useCustomer.getState().logout();
  await AsyncStorage.clear();
  jest.clearAllMocks();
  api.favorites.mockResolvedValue({ items: [], nextCursor: null });
  api.setFavorite.mockResolvedValue(undefined);
  useCustomer.setState({ status: 'signedIn', profile, favorites: [], favoritesLoaded: false, favoriteBusy: [], favoriteError: null });
});

test('hydrates last-confirmed favorites before the network responds', async () => {
  await AsyncStorage.setItem('@dairydirect/favorites-v1:user-1', JSON.stringify(['cached']));
  let finish!: (value: { items: string[]; nextCursor: null }) => void;
  api.favorites.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const work = useCustomer.getState().loadFavorites();
  for (let n = 0; n < 50 && !useCustomer.getState().favoritesLoaded; n++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(useCustomer.getState().favorites).toEqual(['cached']);
  finish({ items: ['server'], nextCursor: null });
  await work;
  expect(useCustomer.getState().favorites).toEqual(['server']);
  for (let n = 0; n < 20; n++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(await AsyncStorage.getItem('@dairydirect/favorites-v1:user-1')).toBe(JSON.stringify(['server']));
});

test('reconciles a timed-out tap against server state without a duplicate write', async () => {
  await useCustomer.getState().loadFavorites();
  api.setFavorite.mockRejectedValueOnce(new TypeError('timeout'));
  api.favorites.mockResolvedValueOnce({ items: ['product'], nextCursor: null });
  await useCustomer.getState().toggleFavorite('product');
  expect(useCustomer.getState().favorites).toEqual(['product']);
  await settleFavorites();
  expect(api.setFavorite).toHaveBeenCalledTimes(1);
  expect(useCustomer.getState().favorites).toEqual(['product']);
  expect(useCustomer.getState().favoriteError).toBeNull();
});

test('retries the latest intent when the server missed the timed-out tap', async () => {
  await useCustomer.getState().loadFavorites();
  api.setFavorite.mockRejectedValueOnce(new TypeError('timeout')).mockResolvedValueOnce(undefined);
  api.favorites.mockResolvedValueOnce({ items: [], nextCursor: null });
  await useCustomer.getState().toggleFavorite('product');
  await settleFavorites();
  expect(api.setFavorite).toHaveBeenCalledTimes(2);
  expect(api.setFavorite.mock.calls[1]).toEqual(['token', 'product', true]);
  expect(useCustomer.getState().favorites).toEqual(['product']);
  expect(useCustomer.getState().favoriteError).toBeNull();
});

test('a definitive rejection reverts only that product and offers a retry', async () => {
  api.favorites.mockResolvedValueOnce({ items: ['kept'], nextCursor: null });
  await useCustomer.getState().loadFavorites();
  api.setFavorite.mockRejectedValueOnce(new ApiError(404, 'PRODUCT_NOT_FOUND'));
  await useCustomer.getState().toggleFavorite('removed');
  expect(useCustomer.getState().favorites).toEqual(['kept', 'removed']);
  await settleFavorites();
  expect(useCustomer.getState().favorites).toEqual(['kept']);
  expect(useCustomer.getState().favoriteError).toBe('Couldn’t save favorite.');
  api.setFavorite.mockResolvedValueOnce(undefined);
  await useCustomer.getState().retryFavorites();
  await settleFavorites();
  expect(api.setFavorite).toHaveBeenLastCalledWith('token', 'removed', true);
  expect(useCustomer.getState().favorites).toEqual(['kept', 'removed']);
  expect(useCustomer.getState().favoriteError).toBeNull();
});

test('keeps an ambiguous failure resumable through retry', async () => {
  await useCustomer.getState().loadFavorites();
  api.setFavorite.mockRejectedValue(new TypeError('offline'));
  api.favorites.mockResolvedValue({ items: [], nextCursor: null });
  await useCustomer.getState().toggleFavorite('product');
  await settleFavorites();
  expect(useCustomer.getState().favorites).toEqual(['product']);
  expect(useCustomer.getState().favoriteError).toBe('Couldn’t save favorite.');
  api.setFavorite.mockResolvedValueOnce(undefined);
  await useCustomer.getState().retryFavorites();
  await settleFavorites();
  expect(useCustomer.getState().favoriteError).toBeNull();
  expect(useCustomer.getState().favorites).toEqual(['product']);
});

test('serializes writes per product while other products proceed', async () => {
  await useCustomer.getState().loadFavorites();
  const finishes = new Map<string, () => void>();
  api.setFavorite.mockImplementation((_token, id) => new Promise<void>(resolve => { finishes.set(id, resolve); }));
  await useCustomer.getState().toggleFavorite('a');
  await useCustomer.getState().toggleFavorite('b');
  for (let n = 0; n < 50 && api.setFavorite.mock.calls.length < 2; n++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(api.setFavorite).toHaveBeenCalledTimes(2);
  finishes.get('a')?.();
  await settleFavorites();
  expect(useCustomer.getState().favorites).toEqual(expect.arrayContaining(['a', 'b']));
  finishes.get('b')?.();
  await settleFavorites();
  expect(useCustomer.getState().favoriteBusy).toEqual([]);
});
