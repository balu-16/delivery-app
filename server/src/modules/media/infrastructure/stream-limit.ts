import { Transform } from 'node:stream';

/** A stream must fail rather than publish a truncated successful export. */
export function boundedBytes(maxBytes: number): Transform {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('INVALID_MEDIA');
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new Error('EXPORT_SIZE_LIMIT') : null, chunk);
    },
  });
}
