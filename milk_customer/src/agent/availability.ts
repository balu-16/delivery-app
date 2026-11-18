/** The config endpoint is read-only. Retry transient failures without changing
 * the server's decision when it explicitly reports that the assistant is off. */
export async function loadAgentAvailability<T>(
  request: () => Promise<T>,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  const delays = [750, 1500];
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
      const retryable = typeof status !== 'number' || status === 401 || status === 408 || status >= 500;
      if (!retryable || attempt >= delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}
