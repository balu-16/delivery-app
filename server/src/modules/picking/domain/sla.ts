/** SLA windows are wall-clock minutes from task creation (config `pickingSlaMinutes`). */
export function slaDueAt(createdAt: Date, minutes: number): Date {
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440)
    throw new Error('INVALID_SLA_MINUTES');
  return new Date(createdAt.getTime() + minutes * 60_000);
}

export function isBreached(slaDueAt: Date, now: Date): boolean {
  return now.getTime() > slaDueAt.getTime();
}
