import { ApiError } from '../src/api/client';
import { agentRunErrorMessage, customerErrorMessage, errorDiagnostic, requestMessage } from '../src/api/messages';
import { AuthError } from '../src/auth/cognito';

test('maps the plan table exactly and never appends a reference', () => {
  expect(customerErrorMessage(new AuthError('INVALID_CREDENTIALS'))).toBe('Email or password is incorrect.');
  expect(customerErrorMessage(new ApiError(401, 'SESSION_EXPIRED', 'trace-123'))).toBe('Sign in again to continue.');
  expect(customerErrorMessage(new AuthError('EXPIRED_CODE'))).toBe('Request a new verification code.');
  expect(customerErrorMessage(new ApiError(409, 'PRICE_CHANGED', 't-1'))).toBe('Price changed. Review your cart.');
  expect(customerErrorMessage(new ApiError(409, 'ADDRESS_NOT_SERVICEABLE'))).toBe('Delivery isn’t available here.');
  expect(customerErrorMessage(new ApiError(409, 'QUOTE_CONSUMED'))).toBe('This checkout was already used. Check My Dairy for your order.');
  expect(customerErrorMessage(new ApiError(409, 'CART_INTENT_CONSUMED'))).toBe('This checkout was already used. Check My Dairy for your order.');
  expect(customerErrorMessage(new ApiError(409, 'CUTOFF_PASSED'))).toBe('The change deadline has passed.');
  expect(customerErrorMessage(new ApiError(429, 'AGENT_DAILY_LIMIT'))).toBe('Daily limit reached. Resets at 12 AM IST.');
});

test('keeps diagnostics out of the message but available for support', () => {
  const error = new ApiError(401, 'SESSION_EXPIRED', 'trace-123');
  expect(requestMessage(error, 'save this address')).not.toContain('trace-123');
  expect(requestMessage(new ApiError(500, 'INTERNAL', 'not safe\nsecret'))).not.toContain('secret');
  expect(requestMessage(new Error('database internals'))).not.toContain('database internals');
  expect(errorDiagnostic(error)).toContain('trace-123');
});

test('names the failed action for unknown and connection failures', () => {
  expect(customerErrorMessage(new ApiError(500, 'INTERNAL'), 'load orders')).toBe('Couldn’t load orders.');
  expect(customerErrorMessage(new TypeError('offline'), 'load products')).toBe('Couldn’t load products.');
  expect(customerErrorMessage(new Error('x'), 'load your wallet')).toBe('Couldn’t load your wallet.');
});

test('maps assistant run-event codes through the same table', () => {
  expect(agentRunErrorMessage('AGENT_DAILY_LIMIT', 'send this message')).toBe('Daily limit reached. Resets at 12 AM IST.');
  expect(agentRunErrorMessage('AGENT_UNAVAILABLE', 'send this message')).toBe('Couldn’t send this message.');
  expect(agentRunErrorMessage('DRAFT_PENDING')).toBe('Confirm or cancel the pending action first.');
});

test('all customer messages are one line', () => {
  const messages = [
    customerErrorMessage(new AuthError('INVALID_CREDENTIALS')),
    customerErrorMessage(new ApiError(401, 'SESSION_EXPIRED')),
    customerErrorMessage(new ApiError(409, 'PRICE_CHANGED')),
    customerErrorMessage(new ApiError(429, 'AGENT_DAILY_LIMIT')),
    customerErrorMessage(new ApiError(500, 'X'), 'load orders'),
  ];
  for (const message of messages) {
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThan(60);
  }
});
