/** Avoid leaking provider details while preserving missing-object and retry semantics. */
export function storageError(error: unknown): Error {
  if (error instanceof Error && ['INVALID_MEDIA', 'MEDIA_NOT_FOUND'].includes(error.message))
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
    return new Error('MEDIA_NOT_FOUND');
  if (value?.name === 'PreconditionFailed' || value?.$metadata?.httpStatusCode === 412)
    return new Error('INVALID_MEDIA');
  return new Error('ExternalServiceUnavailable');
}
