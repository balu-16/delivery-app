/** P8 must call this with a locked, authoritative task before exposing a phone. */
export interface DeliveryContactContext {
  requestingRiderId: string;
  assignedRiderId: string | null;
  taskStatus: string;
}
export interface CallMaskingPort {
  createCall(fromUserId: string, toUserId: string): Promise<{ callId: string }>;
}
/** Only the assigned rider in an active contact window can see delivery contact details. */
export function canViewDeliveryContact(context: DeliveryContactContext): boolean {
  return (
    context.assignedRiderId !== null &&
    context.assignedRiderId === context.requestingRiderId &&
    ['ASSIGNED', 'AT_STORE', 'PICKED_UP', 'ARRIVED'].includes(context.taskStatus)
  );
}
