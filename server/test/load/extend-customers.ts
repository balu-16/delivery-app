import { readFile, writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { uuidV7 } from '../../src/common/ids/ids.js';
import { createDatabase } from '../../src/platform/database/database.js';
import { LocalTokenAdapter } from '../../src/adapters/auth/local.js';
import { WalletCreditService } from '../../src/modules/wallet/infrastructure/postgres-credits.js';
import { WalletPrimitives } from '../../src/modules/wallet/infrastructure/postgres-wallet.js';
async function main() {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.AUTH_PROVIDER !== 'local' ||
    process.env.LOAD_FIXTURES !== 'yes'
  )
    throw new Error('Dedicated local fixture only');
  const url = process.env.DATABASE_URL,
    secret = process.env.LOCAL_JWT_SECRET,
    input = process.env.LOAD_FIXTURE_FILE,
    output = process.env.LOAD_FIXTURE_OUTPUT;
  if (!url || !secret || !input || !output || input === output)
    throw new Error(
      'DATABASE_URL, LOCAL_JWT_SECRET, LOAD_FIXTURE_FILE and distinct LOAD_FIXTURE_OUTPUT required',
    );
  const additional = Number(process.env.LOAD_CUSTOMERS_ADD ?? '603');
  if (!Number.isSafeInteger(additional) || additional < 1 || additional > 20000)
    throw new Error('Invalid LOAD_CUSTOMERS_ADD');
  const fixture = JSON.parse(await readFile(input, 'utf8')) as {
    customers: { id: string; addressId: string; token: string }[];
  };
  const db = createDatabase(url),
    client = new Client({ connectionString: url });
  await client.connect();
  try {
    const credit = new WalletCreditService(new WalletPrimitives(db.db)),
      signer = new LocalTokenAdapter(secret, db.db),
      prefix = `p13-extra-${uuidV7()}`;
    for (let i = 0; i < additional; i++) {
      const sub = `${prefix}-${i}`,
        id = uuidV7(),
        addressId = uuidV7();
      await client.query(
        "INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES($1,'CUSTOMER',$2,$3,$2,true)",
        [id, sub, `${sub}@example.invalid`],
      );
      await client.query("INSERT INTO user_roles(user_id,role) VALUES($1,'CUSTOMER')", [id]);
      await client.query('INSERT INTO customer_profiles(user_id) VALUES($1)', [id]);
      await client.query(
        "INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES($1,$2,'load road','560001','load','+919876543210',ST_SetSRID(ST_MakePoint(77.59,12.97),4326)::geography,true)",
        [addressId, id],
      );
      await credit.credit({
        userId: id,
        bucket: 'cash',
        amountPaise: '10000000',
        reason: 'TOPUP_CREDIT',
        refType: 'P13_FIXTURE',
        refId: `${prefix}-${i}`,
      });
      fixture.customers.push({
        id,
        addressId,
        token: await signer.issue('CUSTOMER', sub, 'customer', 'access', 86400),
      });
    }
    await writeFile(output, JSON.stringify(fixture), { mode: 0o600, flag: 'wx' });
    console.log(`Added ${additional} ledger-funded customers; wrote ${output}`);
  } finally {
    await client.end();
    await db.close();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
