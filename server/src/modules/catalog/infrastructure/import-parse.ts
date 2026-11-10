import { Transform, type Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { parseImportRow, type ImportRow } from '../domain/import.js';
export interface ImportError {
  row: number;
  code: string;
}
/** Input remains bounded by both provider object size and bytes observed on the stream. */
export async function parseImport(
  input: Readable,
  maxBytes: number,
  maxRows: number,
  allowedGst: number[],
): Promise<{ rows: ImportRow[]; rowNumbers: number[]; errors: ImportError[]; total: number }> {
  let bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const strictUtf8 = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error('IMPORT_TOO_LARGE');
        done(null, decoder.decode(chunk, { stream: true }));
      } catch (e) {
        done(e as Error);
      }
    },
    flush(done) {
      try {
        done(null, decoder.decode());
      } catch (e) {
        done(e as Error);
      }
    },
  });
  const expected = [
    'sku',
    'barcode',
    'product_name',
    'variant_name',
    'category_id',
    'hsn_code',
    'gst_rate_bps',
    'perishable',
    'expiry_tracking',
    'selling_paise',
    'mrp_paise',
  ];
  const parser = parse({
    bom: true,
    columns: (headers: string[]) => {
      if (
        headers.length !== expected.length ||
        new Set(headers).size !== headers.length ||
        headers.some((h) => !expected.includes(h))
      )
        throw new Error('INVALID_CSV');
      return headers;
    },
    skip_empty_lines: true,
    relax_column_count: false,
    max_record_size: 65536,
  });
  input.on('error', (error) => strictUtf8.destroy(error));
  strictUtf8.on('error', (error) => parser.destroy(error));
  input.pipe(strictUtf8).pipe(parser);
  const rows: ImportRow[] = [],
    rowNumbers: number[] = [],
    errors: ImportError[] = [],
    skus = new Set<string>(),
    barcodes = new Set<string>();
  let rowNumber = 1;
  try {
    for await (const raw of parser as AsyncIterable<Record<string, string>>) {
      rowNumber++;
      if (rowNumber - 1 > maxRows) throw new Error('IMPORT_TOO_MANY_ROWS');
      try {
        const row = parseImportRow(raw, allowedGst);
        if (skus.has(row.sku)) throw new Error('DUPLICATE_SKU');
        skus.add(row.sku);
        if (row.barcode && barcodes.has(row.barcode)) throw new Error('DUPLICATE_BARCODE');
        if (row.barcode) barcodes.add(row.barcode);
        rows.push(row);
        rowNumbers.push(rowNumber);
      } catch (error) {
        errors.push({
          row: rowNumber,
          code: error instanceof Error ? error.message : 'INVALID_ROW',
        });
      }
    }
  } catch (error) {
    input.destroy();
    strictUtf8.destroy();
    parser.destroy();
    const message = error instanceof Error ? error.message : '';
    if (message === 'IMPORT_TOO_LARGE' || message === 'IMPORT_TOO_MANY_ROWS') throw error;
    throw new Error('INVALID_CSV', { cause: error });
  }
  if (rowNumber === 1) throw new Error('INVALID_CSV');
  return { rows, rowNumbers, errors, total: rowNumber - 1 };
}
