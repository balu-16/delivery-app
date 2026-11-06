import 'reflect-metadata';
import fs from 'node:fs/promises';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createApplication } from '../dist/bootstrap.js';
import { readEnv } from '../dist/config/env.schema.js';
import { makeOpenApiDocument } from '../dist/common/http/openapi.js';

const env = readEnv({ NODE_ENV: 'test', APP_ROLE: 'all', PORT: '0', LOG_LEVEL: 'silent' });
const app = await createApplication(env, []);
const directory = path.resolve('openapi');
try {
  await fs.mkdir(directory, { recursive: true });
  for (const surface of ['customer', 'rider', 'store', 'admin']) {
    const document = makeOpenApiDocument(app, surface);
    if (document.openapi !== '3.1.0') throw new Error(`Invalid OpenAPI version for ${surface}`);
    const operations = Object.entries(document.paths).flatMap(([route, item]) => {
      if (!route.startsWith(`/v1/${surface}/`)) {
        throw new Error(`Cross-surface OpenAPI route: ${surface}: ${route}`);
      }
      return Object.keys(item ?? {}).filter((method) =>
        ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'].includes(method),
      );
    });
    await SwaggerParser.validate(structuredClone(document));
    await fs.writeFile(
      path.join(directory, `${surface}.json`),
      `${JSON.stringify(document, null, 2)}\n`,
    );
    process.stdout.write(`${surface}: ${operations.length} operations; OpenAPI 3.1 validated\n`);
  }
} finally {
  await app.close();
}
