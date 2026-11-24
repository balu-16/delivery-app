import {
  extractPlaceholders,
  permittedPlaceholders,
  renderTemplate,
  resolveLocale,
  sampleDataFor,
  selectTemplate,
  validatePlaceholders,
  type TemplateRow,
} from '../../../src/modules/notifications/domain/render.js';

const rows: TemplateRow[] = [
  {
    templateKey: 'order.confirmed',
    locale: 'en',
    channel: 'PUSH',
    subject: 'Confirmed',
    body: 'Order {{orderNumber}} confirmed',
  },
  {
    templateKey: 'order.confirmed',
    locale: 'hi',
    channel: 'PUSH',
    subject: 'पुष्टि',
    body: 'ऑर्डर {{orderNumber}} की पुष्टि',
  },
  {
    templateKey: 'order.confirmed',
    locale: 'en',
    channel: 'EMAIL',
    subject: 'Order {{orderNumber}}',
    body: 'Dear customer, order {{orderNumber}} is confirmed.',
  },
];

describe('template rendering', () => {
  it('substitutes placeholders', () => {
    expect(renderTemplate('Order {{orderNumber}} confirmed', { orderNumber: 'ORD-1' })).toBe(
      'Order ORD-1 confirmed',
    );
    expect(renderTemplate(rows[2]!.body, { orderNumber: 'ORD-9' })).toBe(
      'Dear customer, order ORD-9 is confirmed.',
    );
  });
  it('renders unknown placeholders empty and truncates long values', () => {
    expect(renderTemplate('Hi {{name}} {{missing}}', {})).toBe('Hi  ');
    expect(renderTemplate('Hi {{name}}', { name: 'x'.repeat(600) })).toBe(`Hi ${'x'.repeat(500)}`);
  });
  it('ignores malformed placeholder syntax', () => {
    expect(renderTemplate('a {{ b }} {{1c}} {{}}', {})).toBe('a {{ b }} {{1c}} {{}}');
  });
});

describe('placeholder validation against the matrix (customize2 §3E)', () => {
  it('exposes permitted placeholders per template key', () => {
    expect([...permittedPlaceholders('order.confirmed')].sort()).toEqual([
      'orderId',
      'orderNumber',
    ]);
    expect([...permittedPlaceholders('agent.reorder_nudge')].sort()).toEqual([
      'productName',
      'variantId',
    ]);
    expect([...permittedPlaceholders('agent.nope')]).toEqual([]);
  });
  it('extracts placeholder keys from subject and body', () => {
    expect(extractPlaceholders('Order {{orderNumber}} {{orderNumber}} {{amount}}')).toEqual([
      'orderNumber',
      'amount',
    ]);
    expect(extractPlaceholders('No placeholders here')).toEqual([]);
  });
  it('accepts permitted placeholders and rejects unknown ones', () => {
    expect(
      validatePlaceholders('order.confirmed', 'Order {{orderNumber}}', 'Confirmed {{orderId}}'),
    ).toEqual({ unknown: [] });
    expect(
      validatePlaceholders('order.confirmed', 'Hi {{name}}', 'Order {{orderNumber}} {{hack}}'),
    ).toEqual({
      unknown: ['hack', 'name'],
    });
  });
  it('provides sample data covering every permitted key for preview', () => {
    const sample = sampleDataFor('agent.reorder_nudge');
    expect(sample['productName']).toBe('Whole Milk (500 ml)');
    expect(renderTemplate('Restock {{productName}}?', sample)).toContain('Whole Milk');
    expect(sampleDataFor('order.confirmed')['orderNumber']).toBe('ORD-1234');
  });
  it('falls back across channels only to INBOX as a last resort', () => {
    expect(selectTemplate(rows, 'order.confirmed', 'EMAIL', 'hi')?.channel).toBe('EMAIL');
    expect(selectTemplate(rows, 'order.confirmed', 'PUSH', 'te')?.locale).toBe('en');
  });
});

describe('locale fallback', () => {
  it('keeps supported locales and falls back to en', () => {
    expect(resolveLocale('hi')).toBe('hi');
    expect(resolveLocale('te')).toBe('te');
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('fr')).toBe('en');
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });
  it('selects the requested locale then falls back to en per channel', () => {
    expect(selectTemplate(rows, 'order.confirmed', 'PUSH', 'hi')?.locale).toBe('hi');
    expect(selectTemplate(rows, 'order.confirmed', 'PUSH', 'te')?.locale).toBe('en');
    expect(selectTemplate(rows, 'order.confirmed', 'EMAIL', 'hi')?.locale).toBe('en');
    expect(selectTemplate(rows, 'order.confirmed', 'EMAIL', 'en')?.channel).toBe('EMAIL');
  });
  it('never crosses to another template key', () => {
    expect(selectTemplate(rows, 'order.cancelled', 'PUSH', 'en')).toBeNull();
  });
});
