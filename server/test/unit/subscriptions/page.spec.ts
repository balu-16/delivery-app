import { decodePage, pageResult } from '../../../src/modules/subscriptions/domain/page.js';

describe('subscription page cursors', () => {
  it('validates bounds, malformed tokens, and collection scope', () => {
    expect(decodePage(undefined, 'plans', undefined)).toEqual({ after: null, limit: 50 });
    expect(() => decodePage(undefined, 'plans', 0)).toThrow('INVALID_PAGE');
    expect(() => decodePage(undefined, 'plans', 101)).toThrow('INVALID_PAGE');
    expect(() => decodePage('invalid', 'plans', 1)).toThrow('INVALID_PAGE');
    const cursor = pageResult([{ id: 'a' }, { id: 'b' }], 1, 'plans', (r) => r.id).nextCursor!;
    expect(decodePage(cursor, 'plans', 1)).toEqual({ after: 'a', limit: 1 });
    expect(() => decodePage(cursor, 'other', 1)).toThrow('INVALID_PAGE');
  });
  it('ends pagination exactly on a full last page and on empty data', () => {
    expect(pageResult([{ id: 'a' }], 1, 'plans', (r) => r.id).nextCursor).toBeNull();
    expect(pageResult<{ id: string }>([], 1, 'plans', (r) => r.id)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
