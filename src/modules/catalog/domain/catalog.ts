/** Search keys are stored in normalized form to match JavaScript and PostgreSQL consistently. */
export function normalizeSearch(input: string): string {
  if (
    input.length > 64 ||
    Array.from(input).some((c) => {
      const n = c.codePointAt(0)!;
      return n <= 31 || (n >= 127 && n <= 159);
    })
  )
    throw new Error('INVALID_SEARCH_QUERY');
  return input.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}
export function normalizeName(input: string): string {
  return input.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}
export function assertMoney(selling: string, mrp: string): void {
  if (!/^\d{1,18}$/.test(selling) || !/^\d{1,18}$/.test(mrp) || BigInt(selling) > BigInt(mrp))
    throw new Error('INVALID_PRICE');
}
export function availability(
  onHand: string,
  reserved: string,
  threshold: number,
): {
  availability: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
  remaining?: string;
} {
  const n = BigInt(onHand) - BigInt(reserved);
  if (n <= 0n) return { availability: 'OUT_OF_STOCK' };
  if (n < BigInt(threshold)) return { availability: 'LOW_STOCK', remaining: n.toString() };
  return { availability: 'IN_STOCK' };
}

/** Replace longest matching original phrases once, without recursively expanding replacements. */
export function expandSynonyms(
  query: string,
  synonyms: ReadonlyArray<{ term: string; expansion: string }>,
): string {
  const words = query.split(' '),
    mapping = new Map(synonyms.map((s) => [s.term, s.expansion])),
    output: string[] = [];
  for (let i = 0; i < words.length;) {
    let matched = false;
    for (let end = words.length; end > i; end--) {
      const replacement = mapping.get(words.slice(i, end).join(' '));
      if (replacement !== undefined) {
        output.push(replacement);
        i = end;
        matched = true;
        break;
      }
    }
    if (!matched) {
      output.push(words[i]!);
      i++;
    }
  }
  const expanded = output.join(' ');
  return expanded.length <= 256 ? expanded : query;
}
export function synonymPhrases(query: string): string[] {
  const words = query.split(' '),
    phrases: string[] = [];
  for (let start = 0; start < words.length; start++)
    for (let end = start + 1; end <= words.length; end++)
      phrases.push(words.slice(start, end).join(' '));
  return phrases;
}
