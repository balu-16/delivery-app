import { Readable } from 'node:stream';
import { parseImport } from '../../../src/modules/catalog/infrastructure/import-parse.js';
import { csvCell } from '../../../src/modules/catalog/domain/import.js';
const header =
  'sku,barcode,product_name,variant_name,category_id,hsn_code,gst_rate_bps,perishable,expiry_tracking,selling_paise,mrp_paise\n';
const row =
  'MILK-1,,Milk,Litre,0193d234-0000-7000-8000-000000000000,0401,500,false,false,9000,10000\n';
describe('bounded UTF-8 CSV import', () => {
  it('accepts BOM, rejects duplicates, and escapes spreadsheet formulas', async () => {
    const parsed = await parseImport(
      Readable.from([Buffer.from('\ufeff' + header + row + row)]),
      10000,
      10,
      [500],
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.errors).toEqual([{ row: 3, code: 'DUPLICATE_SKU' }]);
    expect(csvCell('=1+1')).toBe('"\'=1+1"');
  });
  it('rejects duplicate, unknown and empty headers', async () => {
    await expect(
      parseImport(
        Readable.from([Buffer.from(header.replace('barcode', 'sku') + row)]),
        10000,
        10,
        [500],
      ),
    ).rejects.toThrow('INVALID_CSV');
    await expect(
      parseImport(
        Readable.from([Buffer.from(header.replace('barcode', 'unknown') + row)]),
        10000,
        10,
        [500],
      ),
    ).rejects.toThrow('INVALID_CSV');
    await expect(
      parseImport(Readable.from([Buffer.from(header)]), 10000, 10, [500]),
    ).rejects.toThrow('INVALID_CSV');
  });
  it('rejects malformed UTF-8 and file or row limit violations', async () => {
    await expect(
      parseImport(Readable.from([Buffer.from([0xc3, 0x28])]), 1000, 10, [500]),
    ).rejects.toThrow('INVALID_CSV');
    await expect(
      parseImport(Readable.from([Buffer.from(header + row)]), 10, 10, [500]),
    ).rejects.toThrow('IMPORT_TOO_LARGE');
    await expect(
      parseImport(Readable.from([Buffer.from(header + row + row)]), 10000, 1, [500]),
    ).rejects.toThrow('IMPORT_TOO_MANY_ROWS');
  });
});
