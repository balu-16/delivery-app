/** A readiness check must reject when its dependency is unavailable. */
export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<void>;
}
export const READINESS_PROBES = Symbol('READINESS_PROBES');
