import {
  availability,
  assertMoney,
  normalizeSearch,
  expandSynonyms,
  synonymPhrases,
} from '../../../src/modules/catalog/domain/catalog.js';
describe('catalog value rules', () => {
  it('normalizes accents and whitespace but rejects controls and oversized search', () => {
    expect(normalizeSearch('  Dóódh   MiLk  ')).toBe('doodh milk');
    expect(() => normalizeSearch('milk\nfoo')).toThrow('INVALID_SEARCH_QUERY');
    expect(() => normalizeSearch('a'.repeat(65))).toThrow('INVALID_SEARCH_QUERY');
  });
  it('keeps money exact and never discloses high stock counts', () => {
    expect(() => assertMoney('999999999999999999', '100000000000000000')).toThrow('INVALID_PRICE');
    expect(availability('10', '0', 5)).toEqual({ availability: 'IN_STOCK' });
    expect(availability('10', '8', 5)).toEqual({ availability: 'LOW_STOCK', remaining: '2' });
    expect(availability('10', '10', 5)).toEqual({ availability: 'OUT_OF_STOCK' });
  });
  it('expands longest original phrases once without cycles or cascading', () => {
    expect(
      expandSynonyms('fresh doodh', [
        { term: 'doodh', expansion: 'milk' },
        { term: 'milk', expansion: 'cream' },
      ]),
    ).toBe('fresh milk');
    expect(
      expandSynonyms('red cow milk', [
        { term: 'cow milk', expansion: 'doodh' },
        { term: 'milk', expansion: 'cream' },
      ]),
    ).toBe('red doodh');
    expect(synonymPhrases('fresh doodh')).toContain('fresh doodh');
  });
});
