/**
 * UUID v4 generation without native modules, so it works in every runtime
 * (Expo Go, dev builds, web, Jest). The IDs are only used to tag local
 * records, so the Math.random fallback is acceptable.
 */
type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

const HEX = "0123456789abcdef";

export function randomUUID(): string {
  const crypto = (globalThis as { crypto?: CryptoLike }).crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  let hex = "";
  for (let i = 0; i < 16; i++)
    hex += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
