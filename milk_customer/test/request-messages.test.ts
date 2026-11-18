import { ApiError } from '../src/api/client';
import { requestMessage } from '../src/api/messages';

test('explains common errors and includes only safe support references', () => {
  expect(requestMessage(new ApiError(401,'SESSION_EXPIRED','trace-123'),'save this address')).toBe('Your session has expired. Sign in again and try to save this address. Reference: trace-123');
  expect(requestMessage(new ApiError(409,'ADDRESS_LOCATION_REQUIRED'))).toMatch(/Confirm the location/);
  expect(requestMessage(new ApiError(500,'INTERNAL','not safe\nsecret'))).not.toContain('secret');
  expect(requestMessage(new Error('database internals'))).not.toContain('database internals');
});
