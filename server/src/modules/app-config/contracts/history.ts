export const CONFIG_HISTORY = Symbol('CONFIG_HISTORY');
export interface ConfigHistory {
  recent(
    actorId: string,
  ): Promise<
    Array<{
      id: string;
      actor: string;
      action: string;
      subject: string;
      details: unknown;
      occurredAt: string;
    }>
  >;
}
