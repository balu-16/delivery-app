/** Keep a pasted Indian prefix from appearing twice next to the fixed +91 label. */
export function indianPhoneInput(value: string): string {
  const compact = value.replace(/[\s()-]/g, '');
  if (compact.startsWith('+91')) return compact.slice(3);
  if (/^91\d{10}$/.test(compact)) return compact.slice(2);
  return compact;
}

/** Customer input is local; Cognito and the API continue to receive E.164. */
export function indianPhoneE164(value: string): string | null {
  const local = indianPhoneInput(value);
  return /^\d{10}$/.test(local) ? `+91${local}` : null;
}
