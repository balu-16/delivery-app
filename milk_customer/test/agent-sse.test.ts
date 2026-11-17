import { SseParser } from '../src/agent/sse';
import type { AgentEvent } from '../src/agent/types';

describe('assistant event stream', () => {
  test('parses split UTF-8, comments, CRLF and multiple events', () => {
    const events: AgentEvent[] = [];
    const parser = new SseParser(event => events.push(event));
    const bytes = new TextEncoder().encode(': keepalive\r\nevent: message.delta\r\ndata: {"text":"పాలు"}\r\n\r\nevent: run.ended\ndata: {}\n\n');
    for (let i = 0; i < bytes.length; i += 2) parser.push(bytes.slice(i, i + 2));
    parser.finish();
    expect(events).toEqual([{ event: 'message.delta', data: { text: 'పాలు' } }, { event: 'run.ended', data: {} }]);
  });
  test('rejects malformed JSON rather than rendering it', () => {
    const parser = new SseParser(() => undefined);
    expect(() => parser.push(new TextEncoder().encode('event: card\ndata: {bad}\n\n'))).toThrow('INVALID_AGENT_EVENT');
  });
});
