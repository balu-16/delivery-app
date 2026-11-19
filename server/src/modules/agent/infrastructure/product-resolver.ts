/** One product resolver for assistant cart work, with or without an address.
 * Matching is purely textual and runs before availability or size checks:
 * the longest complete phrase in the customer's current message wins, so
 * "butter milk", "butter-milk" and "buttermilk" all resolve to Buttermilk
 * while a standalone "butter" resolves to Butter. Fuzzy results stay for
 * general discovery; cart requests use only these exact candidates. */

export interface ResolverItem {
  productId: string;
  variantId: string;
  name: string;
  variantName: string;
  sellingPaise: string;
  availability: string;
  maxPerOrder: number;
}

export interface ExactCandidate {
  productId: string;
  variantId: string;
  productKey: string;
  phrase: string;
  name: string;
  variantName: string;
  sellingPaise: string;
  availability: string;
  maxPerOrder: number;
}

export interface ProductResolution {
  /** Distinct requested products in order of first mention. */
  requested: { key: string; phrase: string }[];
  /** Catalog items for the requested products, exact matches only. */
  exact: ExactCandidate[];
  /** One product, several variants, and no size named in the message. */
  ambiguous: boolean;
  /** Exact matches that cannot be sold right now. */
  unavailable: ExactCandidate[];
}

/** Message spellings that name the same catalog product after normalization. */
const PRODUCT_ALIASES: Readonly<Record<string, string>> = {
  'butter milk': 'buttermilk',
  buttermilk: 'buttermilk',
};

/** Normalize like the catalog, with spaces and hyphens treated the same. */
export function normalizeProductText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[_/‐‑‒–—―-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Canonical product key: aliases collapse known spelling variants. */
export function canonicalProductKey(name: string): string {
  const normalized = normalizeProductText(name);
  return PRODUCT_ALIASES[normalized] ?? normalized;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the whole phrase occurs with Unicode-aware word boundaries. */
export function phraseInText(phrase: string, text: string): boolean {
  const needle = normalizeProductText(phrase);
  if (!needle) return false;
  const haystack = normalizeProductText(text);
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(
    haystack,
  );
}

interface Span {
  start: number;
  end: number;
  phrase: string;
}

/**
 * Longest complete phrases in the message, matched before availability/size.
 * Longer phrases win overlapping spans, so "buttermilk and butter" yields
 * two products while "butter milk" stays one phrase.
 */
export function extractRequestedPhrases(
  message: string,
  knownNames: readonly string[],
): { key: string; phrase: string }[] {
  const haystack = normalizeProductText(message);
  if (!haystack) return [];
  const phrases = [
    ...new Set([...Object.keys(PRODUCT_ALIASES), ...knownNames.map(normalizeProductText)]),
  ]
    .filter((phrase) => phrase.length > 0)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const taken: Span[] = [];
  const overlaps = (start: number, end: number): boolean =>
    taken.some((span) => start < span.end && end > span.start);
  for (const phrase of phrases) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`,
      'gu',
    );
    for (const match of haystack.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (!overlaps(start, end)) taken.push({ start, end, phrase });
    }
  }
  taken.sort((a, b) => a.start - b.start);
  const seen = new Set<string>();
  const requested: { key: string; phrase: string }[] = [];
  for (const span of taken) {
    const key = PRODUCT_ALIASES[span.phrase] ?? span.phrase;
    if (seen.has(key)) continue;
    seen.add(key);
    requested.push({ key, phrase: span.phrase });
  }
  return requested;
}

const compact = (value: string): string => normalizeProductText(value).replace(/ /g, '');

/**
 * Address-free preview match: spaces and hyphens never hide a product, so
 * "butter milk" still finds the Buttermilk row. Kept fuzzy for discovery;
 * cart requests narrow these rows down to exact candidates afterwards.
 */
export function catalogTextMatches(query: string, name: string, variantName: string): boolean {
  const needle = compact(query);
  if (!needle) return false;
  return compact(`${name} ${variantName}`).includes(needle);
}

/** Variant ids whose size phrase the message names (spaced or compact). */
export function matchVariantSizes(
  message: string,
  variants: readonly { variantId: string; variantName: string }[],
): string[] {
  const haystack = normalizeProductText(message);
  const flat = compact(message);
  return variants
    .filter((variant) => {
      const size = normalizeProductText(variant.variantName);
      if (!size) return false;
      if (phraseInText(size, haystack)) return true;
      const packed = size.replace(/ /g, '');
      return packed.length > 1 && flat.includes(packed);
    })
    .map((variant) => variant.variantId);
}

const UNSALEABLE = new Set(['OUT_OF_STOCK', 'UNAVAILABLE']);

export function resolveProducts(
  message: string,
  items: readonly ResolverItem[],
): ProductResolution {
  const requested = extractRequestedPhrases(
    message,
    items.map((item) => item.name),
  );
  const phrases = new Map(requested.map((entry) => [entry.key, entry.phrase]));
  const exact = items
    .filter((item) => phrases.has(canonicalProductKey(item.name)))
    .map((item) => {
      const productKey = canonicalProductKey(item.name);
      return {
        productId: item.productId,
        variantId: item.variantId,
        productKey,
        phrase: phrases.get(productKey) ?? item.name,
        name: item.name,
        variantName: item.variantName,
        sellingPaise: item.sellingPaise,
        availability: item.availability,
        maxPerOrder: item.maxPerOrder,
      };
    });
  const unavailable = exact.filter((item) => UNSALEABLE.has(item.availability));
  const sizeMatched = requested.length === 1 ? matchVariantSizes(message, exact).length > 0 : false;
  // Only saleable variants force a size question; an out-of-stock size is a
  // stock answer, not a choice.
  const saleableVariants = new Set(
    exact.filter((item) => !UNSALEABLE.has(item.availability)).map((item) => item.variantId),
  ).size;
  const ambiguous = requested.length === 1 && saleableVariants > 1 && !sizeMatched;
  return { requested, exact, ambiguous, unavailable };
}

const CART_VERBS =
  /\b(add|added|adding|buy|buying|order|ordering|cart|purchase|deliver|delivery|send|restock|checkout)\b/i;
const CART_QUANTITY =
  /\b\d+\s*(packets?|packs?|pcs?|pieces?|bottles?|cups?|tubs?|jars?|boxes?|x)\b/i;
const LEADING_WANT = /^\s*(get|need|want|give)\b/i;

/** True when the message asks to change the cart rather than browse. */
export function isCartRequest(message: string): boolean {
  return CART_VERBS.test(message) || CART_QUANTITY.test(message) || LEADING_WANT.test(message);
}
