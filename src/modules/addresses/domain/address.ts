export interface Coordinates {
  lat: number;
  lng: number;
}
export function distanceMetres(a: Coordinates, b: Coordinates): number {
  const rad = (n: number) => (n * Math.PI) / 180;
  const lat = rad(b.lat - a.lat),
    lng = rad(b.lng - a.lng);
  const h =
    Math.sin(lat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(lng / 2) ** 2;
  return 12_742_000 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export interface AddressInput {
  line1: string;
  line2?: string;
  landmark?: string;
  pincode: string;
  contactName: string;
  contactPhone: string;
  point: Coordinates;
}

/** India bounding box is a coarse input guard; serviceability uses actual polygons. */
export function validateIndiaPoint(point: Coordinates): void {
  if (
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lng) ||
    point.lat < 6 ||
    point.lat > 38 ||
    point.lng < 68 ||
    point.lng > 98
  ) {
    throw new Error('INVALID_COORDINATES');
  }
}
export function validateAddress(input: AddressInput): void {
  validateIndiaPoint(input.point);
  if (!/^\d{6}$/.test(input.pincode)) throw new Error('INVALID_PINCODE');
  if (!/^\+[1-9]\d{7,14}$/.test(input.contactPhone)) throw new Error('INVALID_CONTACT_PHONE');
  if (
    !input.contactName.trim() ||
    input.contactName.length > 120 ||
    !input.line1.trim() ||
    input.line1.length > 200 ||
    (input.line2?.length ?? 0) > 200 ||
    (input.landmark?.length ?? 0) > 200
  ) {
    throw new Error('INVALID_ADDRESS');
  }
}
