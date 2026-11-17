import type { AgentEvent } from './types';

/** Incremental SSE parser, including split UTF-8 chunks and multiline data. */
export class SseParser {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private readonly emit: (event: AgentEvent) => void;
  private event = '';
  private data: string[] = [];
  constructor(emit: (event: AgentEvent) => void) { this.emit = emit; }
  push(chunk: Uint8Array): void { this.buffer += this.decoder.decode(chunk, { stream: true }); this.lines(false); }
  finish(): void { this.buffer += this.decoder.decode(); this.lines(true); }
  private lines(finished: boolean): void {
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.line(line);
    }
    if (finished) { if (this.buffer) this.line(this.buffer.replace(/\r$/, '')); this.line(''); this.buffer = ''; }
  }
  private line(line: string): void {
    if (!line) {
      if (this.event && this.data.length) {
        try {
          const parsed: unknown = JSON.parse(this.data.join('\n'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.emit({ event: this.event, data: parsed as Record<string, unknown> });
        } catch { throw new Error('INVALID_AGENT_EVENT'); }
      }
      this.event = ''; this.data = []; return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const key = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (key === 'event') this.event = value;
    if (key === 'data') this.data.push(value);
  }
}
