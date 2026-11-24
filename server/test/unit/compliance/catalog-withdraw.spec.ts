import { isCatalogSelfWithdrawable } from '../../../src/modules/compliance/infrastructure/admin-operations.js';

describe('catalog maker self-withdraw exception (§3B)', () => {
  it('allows only catalog price/import actions', () => {
    expect(isCatalogSelfWithdrawable('CATALOG_PRICE_CHANGE')).toBe(true);
    expect(isCatalogSelfWithdrawable('CATALOG_PRICE_CHANGE_SUPER')).toBe(true);
    expect(isCatalogSelfWithdrawable('CATALOG_IMPORT')).toBe(true);
    expect(isCatalogSelfWithdrawable('CATALOG_IMPORT_SUPER')).toBe(true);
  });
  it('never widens to finance, roles or compliance actions', () => {
    for (const action of [
      'INVENTORY_COUNT',
      'REFUND',
      'PAYOUT',
      'ROLE_CHANGE',
      'FRAUD',
      'WALLET_ADJUSTMENT',
      '',
      'catalog_import',
    ])
      expect(isCatalogSelfWithdrawable(action)).toBe(false);
  });
});
