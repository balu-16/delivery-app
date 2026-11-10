export function validateIndiaPoint(point: { lat: number; lng: number }): void {
  if (
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lng) ||
    point.lat < 6 ||
    point.lat > 38 ||
    point.lng < 68 ||
    point.lng > 98
  )
    throw new Error('INVALID_COORDINATES');
}
