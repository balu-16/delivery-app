/** Web uses one in-memory session and does not start background location tasks. */
export async function withSessionLock<T>(work: () => Promise<T>): Promise<T> {
  return work();
}
