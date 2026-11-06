/** Reject type spoofing before publishing or accepting private documents. */
export function validMediaMagic(type: string, bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes);
  if (type === 'image/jpeg') return b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (type === 'image/png')
    return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/webp')
    return (
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  if (type === 'application/pdf') return b.subarray(0, 5).toString('ascii') === '%PDF-';
  return false;
}
