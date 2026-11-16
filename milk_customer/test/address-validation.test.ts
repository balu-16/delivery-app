import { addressErrors } from '../src/utils/address-validation';
import { indianPhoneE164, indianPhoneInput } from '../src/utils/indian-phone';

const valid = { line1: '12 Main Street', line2: '', pincode: '520001', contact: 'A Customer', phone: '9876543210', point: { lat: 16.50547, lng: 80.64823 } };

test.each([
  ['9876543210', '+919876543210'],
  ['+91 98765 43210', '+919876543210'],
  ['919876543210', '+919876543210'],
  ['9123456789', '+919123456789'],
  ['+1 9876543210', null],
  ['98765', null],
  ['98765432101', null],
])('normalizes Indian phone input %s', (input, expected) => {
  expect(indianPhoneE164(input)).toBe(expected);
});

test('removes a pasted Indian prefix without deleting the start of a ten-digit number', () => {
  expect(indianPhoneInput('+91 98765-43210')).toBe('9876543210');
  expect(indianPhoneInput('9123456789')).toBe('9123456789');
});

test('reports each missing or invalid address field beside that field', () => {
  expect(addressErrors(valid)).toEqual({});
  expect(addressErrors({ ...valid, phone: '123' })).toEqual({ phone: 'Enter a valid 10-digit Indian phone number.' });
  expect(addressErrors({ ...valid, pincode: '5200', point: null })).toEqual({ pincode: 'Enter a six-digit PIN code.', location: 'Select your current location at the delivery address.' });
  expect(addressErrors({ ...valid, line1: '', contact: '' })).toEqual({ line1: 'Enter your house and street.', contact: 'Enter the contact name.' });
});
