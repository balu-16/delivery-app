import { randomBytes, randomInt } from 'node:crypto';

export interface IdGenerator {
  newId(): string;
}
export interface Random {
  int(min: number, maxExclusive: number): number;
}
export class SystemIdGenerator implements IdGenerator {
  newId(): string {
    return uuidV7();
  }
}
export class SystemRandom implements Random {
  int(min: number, maxExclusive: number): number {
    return secureRandomInt(min, maxExclusive);
  }
}

/** RFC 9562 UUIDv7: timestamp ordering at millisecond precision, 74 random bits. */
export function uuidV7(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48)
    throw new Error('Invalid UUIDv7 timestamp');
  const bytes = randomBytes(16);
  bytes.writeUIntBE(nowMs, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function secureRandomInt(min: number, maxExclusive: number): number {
  return randomInt(min, maxExclusive);
}
