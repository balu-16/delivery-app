export interface OutboxResult {
  completed: string;
  processed: string;
  backlog: string;
  suspended: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** Smoke checks wiring; the local profile also requires healthy-period latency evidence. */
export function outboxGatePasses(input: {
  profile: 'smoke' | 'local';
  expected: number;
  generated: number;
  result: OutboxResult | undefined;
  interruptedBacklog: number;
  errors: readonly string[];
}): boolean {
  const { result } = input;
  return Boolean(
    result &&
    input.generated === input.expected &&
    Number(result.completed) === input.generated &&
    result.completed === result.processed &&
    result.backlog === '0' &&
    result.suspended === '0' &&
    (input.profile === 'smoke' || (result.p95 !== null && result.p95 <= 2000)) &&
    input.interruptedBacklog > 0 &&
    input.errors.length === 0,
  );
}
