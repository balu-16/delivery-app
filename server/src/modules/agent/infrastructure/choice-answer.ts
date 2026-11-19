import { normalizeProductText } from './product-resolver.js';

const NUMBER_WORDS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const QUANTITY =
  /^(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*(?:packs?|packets?|pieces?|pcs|bottles?|cups?|tubs?|x|of|the))*$/;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface ChoiceAnswer {
  variantId: string | null;
  quantity: number | null;
}

/** Accept a whole size or quantity answer. Other requests belong in their own flow. */
export function parseChoiceAnswer(
  message: string,
  variants: ReadonlyArray<{ variantId: string; label: string }>,
): (ChoiceAnswer & { partial?: true }) | null {
  if (/(?:^|\s)[+\-−]\s*\d/u.test(message) || /\d[.,]\d/u.test(message)) return null;
  let rest = sizeText(message)
    .replace(/[!?,]+/g, ' ')
    .replace(/\.+$/, '')
    .trim();
  if (!rest || !variants.length) return null;
  rest = rest.replace(/^(?:please\s+)?(?:i(?:'ll| will) take|i(?:'d| would) like)\s+/, '');
  let variantId: string | null = null;
  for (const variant of [...variants].sort((a, b) => b.label.length - a.label.length)) {
    const label = sizeText(variant.label);
    if (!label) continue;
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${escape(label)}(?![\\p{L}\\p{N}])`, 'u');
    if (!match.test(rest)) continue;
    variantId = variant.variantId;
    rest = rest.replace(match, ' ');
    break;
  }
  if (!variantId) {
    const option = /\b(?:option (\d{1,2})|(first|second|third|fourth|fifth|sixth)(?: one)?)\b/.exec(
      rest,
    );
    if (option) {
      const index = option[1] ? Number(option[1]) - 1 : ORDINALS.indexOf(option[2]!);
      variantId = variants[index]?.variantId ?? null;
      if (!variantId) return null;
      rest = rest.replace(option[0], ' ');
    }
  }
  rest = rest
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:the|please)\b\s*)+/, '')
    .replace(/\s*please$/, '')
    .trim();
  if (!rest) return variantId ? { variantId, quantity: null, partial: true } : null;
  const match = QUANTITY.exec(rest);
  if (!match) return null;
  const quantity = /^\d/.test(match[1]!) ? Number(match[1]) : NUMBER_WORDS.indexOf(match[1]!) + 1;
  if (quantity < 1 || quantity > 100) return null;
  variantId ??= variants.length === 1 ? variants[0]!.variantId : null;
  return variantId ? { variantId, quantity } : { variantId, quantity, partial: true };
}

function sizeText(value: string): string {
  return normalizeProductText(value)
    .replaceAll('’', "'")
    .replace(/\b(\d+)\s*(kilograms?|kgs?)\b/g, '$1 kg')
    .replace(/\b(\d+)\s*(grams?|gms?|g)\b/g, '$1 g')
    .replace(/\b(\d+)\s*(millilit(?:er|re)s?|ml)\b/g, '$1 ml');
}

/** Isolate the item phrase in an explicit add request. */
export function addRequestText(message: string): string | null {
  const text = message.trim().replace(/^(?:hi|hey|hello)[!,.\s]+/i, '');
  const request =
    /^(?:please\s+)?add\s+(.+?)(?:\s+(?:to|into)\s+(?:(?:my|the)\s+)?cart)?[.!?]*$/i.exec(text);
  return request?.[1]?.trim() ?? null;
}
