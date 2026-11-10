// Validate phase evidence without treating planned work as completed coverage.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const kinds = ['env', 'requirements', 'operations', 'events', 'adapters', 'invariants'];
const statuses = new Set(['planned', 'implemented', 'verified']);
const surfaces = new Set(['customer', 'rider', 'store', 'admin']);
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const errors = [];
const manifests = {};
const requireString = (value, label) => {
  if (typeof value !== 'string' || !value.trim())
    errors.push(`${label}: expected a nonempty string`);
};
const stringArray = (value, label, nonempty = false) => {
  if (
    !Array.isArray(value) ||
    (nonempty && !value.length) ||
    value.some((entry) => typeof entry !== 'string' || !entry.trim())
  )
    errors.push(`${label}: expected ${nonempty ? 'a nonempty' : 'an'} array of strings`);
};
function validateTestFiles(item, label) {
  if (item.testFiles === undefined && item.status !== 'verified') return;
  stringArray(item.testFiles, `${label}.testFiles`, item.status === 'verified');
  if (!Array.isArray(item.testFiles)) return;
  for (const file of item.testFiles) {
    if (typeof file !== 'string') continue;
    const resolved = path.resolve(root, file);
    if (!resolved.startsWith(`${root}${path.sep}test${path.sep}`) || !existsSync(resolved))
      errors.push(`${label}: test file does not exist in test/: ${file}`);
  }
}

for (const kind of kinds) {
  const file = path.join(root, 'docs', 'manifests', `${kind}.json`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    errors.push(`${file}: missing or invalid JSON`);
    continue;
  }
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.items)) {
    errors.push(`${file}: expected schemaVersion 1 and items array`);
    continue;
  }
  manifests[kind] = manifest.items;
  const ids = new Set();
  for (const [index, item] of manifest.items.entries()) {
    const label = `${kind}[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${label}: expected object`);
      continue;
    }
    requireString(item.id, `${label}.id`);
    if (ids.has(item.id)) errors.push(`${label}: duplicate id ${item.id}`);
    ids.add(item.id);
    if (!statuses.has(item.status)) errors.push(`${label}: invalid status`);
    requireString(item.sourceSection, `${label}.sourceSection`);
    if (typeof item.phase !== 'string' || !/^P(?:[0-9]|1[0-3])$/.test(item.phase))
      errors.push(`${label}: invalid phase`);
    if (['requirements', 'operations', 'adapters', 'invariants'].includes(kind))
      validateTestFiles(item, label);
    if (kind === 'env') {
      requireString(item.key, `${label}.key`);
      if (typeof item.secret !== 'boolean') errors.push(`${label}.secret: expected boolean`);
      requireString(item.description, `${label}.description`);
      if (!Object.hasOwn(item, 'default'))
        errors.push(`${label}.default: required (use null for no default)`);
    }
    if (kind === 'requirements' || kind === 'invariants')
      requireString(item.description, `${label}.description`);
    if (kind === 'events') {
      requireString(item.eventType, `${label}.eventType`);
      stringArray(item.producers, `${label}.producers`);
      stringArray(item.consumers, `${label}.consumers`);
    }
    if (kind === 'adapters') {
      requireString(item.port, `${label}.port`);
      requireString(item.provider, `${label}.provider`);
      if (typeof item.real !== 'boolean') errors.push(`${label}.real: expected boolean`);
      stringArray(item.methods, `${label}.methods`, true);
    }
    if (kind === 'operations') {
      if (!surfaces.has(item.surface)) errors.push(`${label}: invalid surface`);
      if (typeof item.method !== 'string' || !methods.has(item.method.toLowerCase()))
        errors.push(`${label}: invalid method`);
      if (typeof item.path !== 'string' || !item.path.startsWith(`/v1/${item.surface}/`))
        errors.push(`${label}: path must belong to surface`);
      stringArray(item.roles, `${label}.roles`);
      for (const key of ['scope', 'rateLimit', 'idempotency'])
        requireString(item[key], `${label}.${key}`);
    }
  }
}

const operations = manifests.operations ?? [];
const operationKeys = new Set();
for (const item of operations) {
  if (!item || typeof item.method !== 'string' || typeof item.path !== 'string') continue;
  const key = `${item.method.toLowerCase()} ${item.path}`;
  if (operationKeys.has(key)) errors.push(`operations: duplicate ${key}`);
  operationKeys.add(key);
}

// Once exports exist, compare complete audience contracts with implemented operations.
const exportsFound = [...surfaces].filter((surface) =>
  existsSync(path.join(root, 'openapi', `${surface}.json`)),
);
if (exportsFound.length) {
  if (exportsFound.length !== surfaces.size)
    errors.push('openapi: expected an export for every audience');
  const actual = new Set();
  for (const surface of exportsFound) {
    try {
      const doc = JSON.parse(readFileSync(path.join(root, 'openapi', `${surface}.json`), 'utf8'));
      if (doc.openapi !== '3.1.0' || !doc.paths || typeof doc.paths !== 'object')
        throw new Error('invalid document');
      for (const [route, operationsAtPath] of Object.entries(doc.paths)) {
        if (!route.startsWith(`/v1/${surface}/`))
          errors.push(`openapi/${surface}.json: unexpected route ${route}`);
        for (const method of Object.keys(operationsAtPath))
          if (methods.has(method.toLowerCase())) actual.add(`${method.toLowerCase()} ${route}`);
      }
    } catch {
      errors.push(`openapi/${surface}.json: invalid OpenAPI 3.1 document`);
    }
  }
  const expected = new Set(
    operations
      .filter((item) => item && item.status !== 'planned' && typeof item.method === 'string')
      .map((item) => `${item.method.toLowerCase()} ${item.path}`),
  );
  for (const key of actual)
    if (!expected.has(key)) errors.push(`operations: exported route missing from manifest: ${key}`);
  for (const key of expected)
    if (!actual.has(key)) errors.push(`operations: implemented route missing from exports: ${key}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else
  console.log(`Validated ${kinds.length} manifests and ${operationKeys.size} operation records`);
