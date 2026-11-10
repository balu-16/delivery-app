import {
  financialYearFor,
  formatInvoiceNumber,
} from '../../../src/modules/invoicing/domain/invoice-policy.js';

it('uses IST midnight for fiscal year and preserves century rollover labels', () => {
  expect(financialYearFor(new Date('2026-03-31T18:29:59.999Z'))).toBe('2025-26');
  expect(financialYearFor(new Date('2026-03-31T18:30:00.000Z'))).toBe('2026-27');
  expect(financialYearFor(new Date('2026-03-31T18:30:00.001Z'))).toBe('2026-27');
  expect(financialYearFor(new Date('2099-03-31T18:30:00.000Z'))).toBe('2099-00');
  expect(financialYearFor(new Date('2100-03-31T18:30:00.000Z'))).toBe('2100-01');
  expect(formatInvoiceNumber('INV', '2099-00', 1n)).toBe('INV-2099-00-000001');
});
