import { indianPhoneE164 } from './indian-phone';

export type AddressField = 'line1' | 'line2' | 'pincode' | 'contact' | 'phone' | 'location';
export type AddressErrors = Partial<Record<AddressField, string>>;

export function addressErrors(value: {
  line1: string; line2: string; pincode: string; contact: string; phone: string;
  point: { lat: number; lng: number } | null;
}): AddressErrors {
  const errors: AddressErrors = {};
  if (!value.line1.trim()) errors.line1 = 'Enter your house and street.';
  else if (value.line1.trim().length > 200) errors.line1 = 'Use at most 200 characters.';
  if (value.line2.trim().length > 200) errors.line2 = 'Use at most 200 characters.';
  if (!/^\d{6}$/.test(value.pincode)) errors.pincode = 'Enter a six-digit PIN code.';
  if (!value.contact.trim()) errors.contact = 'Enter the contact name.';
  else if (value.contact.trim().length > 120) errors.contact = 'Use at most 120 characters.';
  if (!indianPhoneE164(value.phone)) errors.phone = 'Enter a valid 10-digit Indian phone number.';
  if (!value.point) errors.location = 'Select your current location at the delivery address.';
  return errors;
}
