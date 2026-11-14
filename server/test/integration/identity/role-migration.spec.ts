import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let client: Client;
const migrations = () => ({
  databaseUrl: services.databaseUrl,
  dir: resolve('db/migrations'),
  migrationsTable: 'pgmigrations',
  direction: 'up' as const,
  log: () => undefined,
});

beforeAll(async () => {
  services = await startTestServices();
  // The first 40 migrations end at 041; seed the old schema before upgrading.
  await runner({ ...migrations(), count: 40 });
  client = new Client({ connectionString: services.databaseUrl });
  await client.connect();
}, 300_000);
afterAll(async () => {
  await client?.end();
  await services?.stop();
}, 120_000);

test('legacy roles migrate without promoting pickers or losing historical users', async () => {
  const admin = randomUUID(),
    picker = randomUUID(),
    other = randomUUID();
  await client.query(
    `INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES
    ($1,'WORKFORCE','legacy-admin','admin@example.test','Admin'),
    ($2,'WORKFORCE','legacy-picker','picker@example.test','Picker'),
    ($3,'WORKFORCE','legacy-rider','rider@example.test','Rider')`,
    [admin, picker, other],
  );
  await client.query(
    "INSERT INTO user_roles(user_id,role) VALUES ($1,'ADMIN'),($2,'PICKER'),($3,'RIDER')",
    [admin, picker, other],
  );
  await runner(migrations());
  const users = await client.query<{ cognito_sub: string; status: string; roles: string[] }>(
    `SELECT u.cognito_sub,u.status,
    COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL),'{}') AS roles FROM users u LEFT JOIN user_roles r ON r.user_id=u.id
    WHERE u.id=ANY($1::uuid[]) GROUP BY u.id`,
    [[admin, picker, other]],
  );
  expect(users.rows.find((u) => u.cognito_sub === 'legacy-admin')?.roles).toEqual(['SUPER_ADMIN']);
  expect(users.rows.find((u) => u.cognito_sub === 'legacy-picker')).toMatchObject({
    status: 'BLOCKED',
    roles: [],
  });
  expect(users.rows.find((u) => u.cognito_sub === 'legacy-rider')?.roles).toEqual(['RIDER']);
  await expect(
    client.query("INSERT INTO user_roles(user_id,role) VALUES($1,'STORE_MANAGER')", [other]),
  ).rejects.toMatchObject({ code: '23505' });
  await expect(
    client.query("INSERT INTO user_roles(user_id,role) VALUES($1,'ADMIN')", [picker]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    client.query(
      "INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES($1,'CUSTOMER','legacy-rider','another@example.test','Duplicate')",
      [randomUUID()],
    ),
  ).rejects.toMatchObject({ code: '23505' });
}, 120_000);
