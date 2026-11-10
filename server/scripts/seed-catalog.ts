import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Client } from 'pg';

const fixtureId = (group: number, number: number) =>
  `01800000-0000-7000-800${group}-${number.toString(16).padStart(12, '0')}`;
const imageId = fixtureId(6, 1);
const categories = ['Dairy', 'Pantry', 'Produce', 'Snacks', 'Household'];
const names = [
  'Fresh Milk',
  'Natural Yogurt',
  'Paneer',
  'Salted Butter',
  'Wheat Flour',
  'Basmati Rice',
  'Toor Dal',
  'Sunflower Oil',
  'Tomato',
  'Potato',
  'Banana',
  'Apple',
  'Oat Cookies',
  'Roasted Peanuts',
  'Potato Chips',
  'Dark Chocolate',
  'Dish Soap',
  'Laundry Powder',
  'Paper Towels',
  'Hand Wash',
];
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7mQAAAAASUVORK5CYII=',
  'base64',
);

/** An actual local image, shared by seeded products; never replace an existing object. */
async function seedImage(directory: string): Promise<void> {
  const key = `public/${imageId}`;
  const file = resolve(directory, key);
  await mkdir(resolve(directory, 'public'), { recursive: true });
  for (const [target, bytes] of [
    [file, png],
    [`${file}.type`, Buffer.from('image/png')],
  ] as const) {
    try {
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (!(await readFile(target)).equals(bytes))
        throw new Error('Local seed image conflicts', { cause: error });
    }
  }
}

async function insertRows(client: Client, prefix: string, rows: unknown[][]): Promise<void> {
  for (let start = 0; start < rows.length; start += 100) {
    const batch = rows.slice(start, start + 100);
    const values: unknown[] = [];
    const placeholders = batch.map(
      (row) =>
        `(${row
          .map((value) => {
            values.push(value);
            return `$${values.length}`;
          })
          .join(',')})`,
    );
    await client.query(`${prefix} VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`, values);
  }
}

/** Seed structural assortment only. P4 receipts, never fixtures, supply production stock. */
export async function seedCatalog(client: Client, stores: readonly string[]): Promise<void> {
  const directory = resolve(process.env.LOCAL_CATALOG_STORAGE_DIR ?? '.local/catalog');
  await seedImage(directory);
  const owner = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE pool='WORKFORCE' AND cognito_sub='super-admin-1'",
  );
  const ownerId = owner.rows[0]?.id;
  if (!ownerId) throw new Error('Catalog seed owner missing');
  await client.query(
    "INSERT INTO catalog_media(id,owner_id,purpose,object_key,content_type,size_bytes,state,expires_at,registered_at) VALUES ($1,$2,'PRODUCT_IMAGE',$3,'image/png',$4,'REGISTERED',clock_timestamp()+interval '100 years',clock_timestamp()) ON CONFLICT DO NOTHING",
    [imageId, ownerId, `public/${imageId}`, png.length],
  );
  const brandId = fixtureId(2, 1);
  await client.query('INSERT INTO catalog_brands(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
    brandId,
    'Local Essentials',
  ]);
  for (const [index, name] of categories.entries())
    await client.query(
      'INSERT INTO catalog_categories(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [fixtureId(1, index + 1), name],
    );
  const products: unknown[][] = [];
  const variants: unknown[][] = [];
  const images: unknown[][] = [];
  const inventory: unknown[][] = [];
  const prices: unknown[][] = [];
  for (let index = 1; index <= 200; index++) {
    const nameIndex = (index - 1) % names.length;
    const name = `${names[nameIndex]} ${Math.ceil(index / names.length) * 100} g`;
    const productId = fixtureId(3, index);
    const variantId = fixtureId(4, index);
    const perishable = nameIndex < 4 || (nameIndex >= 8 && nameIndex < 12);
    products.push([
      productId,
      fixtureId(1, Math.floor(nameIndex / 4) + 1),
      brandId,
      name,
      name.toLowerCase(),
      '1001',
      500,
      perishable,
      perishable,
      true,
    ]);
    variants.push([
      variantId,
      productId,
      'Standard pack',
      `LOCAL-${String(index).padStart(4, '0')}`,
      `890000${String(index).padStart(7, '0')}`,
    ]);
    images.push([productId, imageId]);
    for (const [storeIndex, storeId] of stores.entries()) {
      inventory.push([storeId, variantId]);
      prices.push([
        fixtureId(5, index * 10 + storeIndex),
        storeId,
        variantId,
        (10000n + BigInt(index) * 50n).toString(),
        (12000n + BigInt(index) * 50n).toString(),
        '2020-01-01T00:00:00Z',
        ownerId,
      ]);
    }
  }
  await insertRows(
    client,
    'INSERT INTO catalog_products(id,category_id,brand_id,name,normalized_name,hsn_code,gst_rate_bps,perishable,expiry_tracking,published)',
    products,
  );
  await insertRows(
    client,
    'INSERT INTO catalog_variants(id,product_id,name,sku,barcode)',
    variants,
  );
  await insertRows(client, 'INSERT INTO catalog_product_images(product_id,media_id)', images);
  await insertRows(client, 'INSERT INTO store_inventory(store_id,variant_id)', inventory);
  await insertRows(
    client,
    'INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by)',
    prices,
  );
  for (const [term, expansion] of [
    ['doodh', 'milk'],
    ['atta', 'wheat flour'],
  ])
    await client.query(
      'INSERT INTO catalog_synonyms(term,expansion) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [term, expansion],
    );
}
