export interface AddressChangeContext {
  status: string;
  originalZoneId: string;
  newZoneId: string;
  originalDeliveryFeePaise: bigint;
  newDeliveryFeePaise: bigint;
}
/** P6 locks and rechecks the order before invoking this contract. */
export function ensureAddressChangeAllowed(value: AddressChangeContext): void {
  if (
    !['PENDING_PAYMENT', 'CONFIRMED'].includes(value.status) ||
    value.originalZoneId !== value.newZoneId ||
    value.originalDeliveryFeePaise !== value.newDeliveryFeePaise
  ) {
    throw new Error('ADDRESS_CHANGE_NOT_ALLOWED');
  }
}
