import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { isGraphBubbleUp } from '@langchain/langgraph';

const safeErrors = [
  'ADDRESS_REQUIRED',
  'ADDRESS_NOT_FOUND',
  'ORDER_NOT_FOUND',
  'CART_NOT_FOUND',
  'ADDRESS_NOT_SERVICEABLE',
  'INVENTORY_INSUFFICIENT',
  'CONCURRENT_MODIFICATION',
  'INVALID_QUANTITY',
  'SUBSCRIPTIONS_DISABLED',
  'RATE_LIMITED',
];
/** Shared validation, loop guard, status events and safe error envelope for tools. */
export class AgentToolKit {
  private count = 0;
  private readonly calls = new Map<string, number>();
  constructor(private readonly maxCalls: number) {}
  define<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: z.ZodObject<S>,
    handler: (input: z.output<z.ZodObject<S>>, runtime: ToolRuntime) => Promise<unknown>,
  ) {
    return tool(
      async (input, runtime: ToolRuntime) => {
        this.count += 1;
        const fingerprint = `${name}:${JSON.stringify(input)}`;
        this.calls.set(fingerprint, (this.calls.get(fingerprint) ?? 0) + 1);
        if (this.count > this.maxCalls || (this.calls.get(fingerprint) ?? 0) > 2)
          return JSON.stringify({
            ok: false,
            error: { code: 'TOOL_LIMIT_REACHED', retryable: false },
          });
        runtime.writer?.({
          event: 'tool.status',
          data: { labelKey: `agent.tool.${name}`, phase: 'start' },
        });
        try {
          return JSON.stringify({ ok: true, data: await handler(input, runtime) });
        } catch (error: unknown) {
          if (isGraphBubbleUp(error)) throw error;
          const code =
            error instanceof Error && safeErrors.includes(error.message)
              ? error.message
              : 'TOOL_UNAVAILABLE';
          return JSON.stringify({
            ok: false,
            error: { code, retryable: code === 'TOOL_UNAVAILABLE' },
          });
        } finally {
          runtime.writer?.({
            event: 'tool.status',
            data: { labelKey: `agent.tool.${name}`, phase: 'end' },
          });
        }
      },
      { name, description, schema },
    );
  }
}
