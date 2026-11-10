import {
  renderTemplate,
  resolveLocale,
  selectTemplate,
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
