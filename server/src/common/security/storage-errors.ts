/** Avoid leaking provider details while preserving missing-object and retry semantics. */
export function storageError(
  error: unknown,
  missingCode: 'MEDIA_NOT_FOUND' | 'UPLOAD_NOT_RECEIVED' = 'MEDIA_NOT_FOUND',
): Error {
  if (
    error instanceof Error &&
    [
      'INVALID_MEDIA',
      'MEDIA_NOT_FOUND',
      'UPLOAD_NOT_RECEIVED',
      'UPLOAD_PROCESSING',
      'UPLOAD_EXPIRED',
    ].includes(error.message)
  )
    return error;
  const value = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  if (
    value?.code === 'ENOENT' ||
    value?.name === 'NotFound' ||
    value?.name === 'NoSuchKey' ||
    value?.$metadata?.httpStatusCode === 404
  )
    return new Error(missingCode);
  if (value?.name === 'PreconditionFailed' || value?.$metadata?.httpStatusCode === 412)
    return new Error('INVALID_MEDIA');
  return new Error('ExternalServiceUnavailable');
}
