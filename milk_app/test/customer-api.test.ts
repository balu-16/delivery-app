/// <reference types="jest" />
import { ApiError, apiBaseUrl, customerRequest } from '../src/api/client';
import { customerApi } from '../src/api/customer';

const previousUrl = process.env.EXPO_PUBLIC_API_URL;
const fetchMock = jest.fn();
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000/';
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
});
afterAll(() => { process.env.EXPO_PUBLIC_API_URL = previousUrl; });

it('sends authenticated cart mutations with the caller’s idempotency key', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ cart: { version: 2 }, clamped: false }), { status: 200 }));
  await customerApi.putItem('access-token', 'variant-1', { quantity: '2', version: 1, addressId: 'address-1' }, 'same-key');
  expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.10:3000/v1/customer/cart/items/variant-1', expect.objectContaining({
    method: 'PUT',
    headers: expect.objectContaining({ Authorization: 'Bearer access-token', 'Idempotency-Key': 'same-key' }),
    body: JSON.stringify({ quantity: '2', version: 1, addressId: 'address-1' }),
  }));
});

it('exposes safe server problem codes without leaking error details', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'CONCURRENT_MODIFICATION', traceId: 'trace-1', detail: 'private detail' }), { status: 409 }));
  await expect(customerRequest('/v1/customer/cart', { token: 'token' })).rejects.toMatchObject({ status: 409, code: 'CONCURRENT_MODIFICATION', traceId: 'trace-1', message: 'CONCURRENT_MODIFICATION' } as Partial<ApiError>);
});

it('rejects unsafe configured URLs and cross-origin paths', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'https://user:password@example.com';
  expect(() => apiBaseUrl()).toThrow('without credentials');
  await expect(customerRequest('//evil.test/path')).rejects.toThrow('Invalid API path');
});
