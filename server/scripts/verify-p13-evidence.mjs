import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argument = (key) => (args.includes(key) ? args[args.indexOf(key) + 1] : undefined);
const inventory = JSON.parse(fs.readFileSync('test/security/operation-cases.json', 'utf8'));
const operations = JSON.parse(
  fs.readFileSync('docs/manifests/operations.json', 'utf8'),
).items.filter((row) => row.status !== 'planned');
const resultsPath = argument('--results');
const results = resultsPath ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : null;
const normalized = (value) => value.replace(/\{[^}]+\}/g, '{}');
const operationKey = (row) => row.method.toUpperCase() + ' ' + normalized(row.path);
const expected = new Set(operations.map(operationKey));
const seen = new Set();
const fields = ['authentication', 'authorization', 'validation', 'replay', 'success'];
const counts = Object.fromEntries(fields.map((name) => [name, {}]));
const errors = [];
for (const row of inventory.items) {
  const key = operationKey(row);
  if (!expected.has(key) || seen.has(key)) errors.push(`Unknown or duplicate operation: ${key}`);
  seen.add(key);
  for (const field of fields) {
    const entry = row[field];
    if (!entry || !['covered', 'partial', 'unassessed', 'not-applicable'].includes(entry.status)) {
      errors.push(`${key}: missing criterion ${field}`);
      continue;
    }
    counts[field][entry.status] = (counts[field][entry.status] ?? 0) + 1;
    if (entry.status !== 'covered' && !entry.reason)
      errors.push(`${key}/${field}: reason required`);
    const references = [
      ...(entry.test ? [entry.test] : []),
      ...(entry.additionalTests ?? []),
      ...(entry.criteria ?? []).flatMap((criterion) => (criterion.test ? [criterion.test] : [])),
    ];
    if (entry.status === 'covered' && !references.length)
      errors.push(`${key}/${field}: named test required`);
    for (const criterion of entry.criteria ?? []) {
      if (criterion.status === 'not-applicable' ? !criterion.reason : !criterion.test)
        errors.push(`${key}/${field}: criterion needs a named test or explicit inapplicability`);
    }
    for (const reference of references) {
      const separator = reference.indexOf(': ');
      const file = reference.slice(0, separator);
      const title = reference.slice(separator + 2);
      if (separator < 0 || !file.startsWith('test/') || !fs.existsSync(file) || !title)
        errors.push(`${key}/${field}: invalid test reference`);
      else if (results) {
        const suite = results.testResults.find(
          (result) => path.resolve(result.name) === path.resolve(file),
        );
        const assertion = suite?.assertionResults.find(
          (result) => result.title === title || result.fullName === title,
        );
        if (!assertion || assertion.status !== 'passed')
          errors.push(`${key}/${field}: named test did not pass: ${reference}`);
      }
    }
  }
}
for (const key of expected) if (!seen.has(key)) errors.push(`Missing operation: ${key}`);
if (results && !results.success) errors.push('The supplied test run did not pass');
const gaps = fields.reduce(
  (sum, field) => sum + (counts[field].partial ?? 0) + (counts[field].unassessed ?? 0),
  0,
);
const edge = JSON.parse(fs.readFileSync('test/security/edge-case-evidence.json', 'utf8'));
const register = fs.readFileSync('docs/EDGE_CASES.md', 'utf8');
const edgeExpected = new Set(
  [...register.matchAll(/^\| ((?:CON|PAY|INV|GEO|DSP|RTN|SEC|TIM|OPS|ADD|SYS)-\d{2}) \|/gm)].map(
    (match) => match[1],
  ),
);
const edgeSeen = new Set();
let edgeGaps = 0;
for (const item of edge.cases) {
  if (!edgeExpected.has(item.id) || edgeSeen.has(item.id))
    errors.push(`Unknown or duplicate edge item: ${item.id}`);
  edgeSeen.add(item.id);
  if (!['covered', 'partial', 'external'].includes(item.status))
    errors.push(`Invalid edge status: ${item.id}`);
  for (const criterion of item.criteria ?? []) {
    if (
      !['covered', 'missing', 'pending', 'partial', 'external', 'not-applicable'].includes(
        criterion.status,
      )
    )
      errors.push(`Invalid edge criterion status: ${item.id}`);
    if (item.status === 'covered' && !['covered', 'not-applicable'].includes(criterion.status))
      errors.push(`Covered edge item contains an incomplete criterion: ${item.id}`);
    if (criterion.status === 'covered' && !criterion.tests?.length)
      errors.push(`Covered edge criterion needs a named test: ${item.id}`);
  }
  if (item.status !== 'covered') {
    if (item.status === 'partial') edgeGaps++;
    if (!item.missingCriteria) errors.push(`Missing edge limitation: ${item.id}`);
    if (item.status === 'external' && (!item.owner || !item.acceptanceStep))
      errors.push(`External edge item needs an owner and acceptance step: ${item.id}`);
  }
  if (item.status === 'covered' && !item.tests?.length)
    errors.push(`Missing edge test: ${item.id}`);
  for (const reference of [
    ...(item.tests ?? []),
    ...(item.criteria ?? []).flatMap((criterion) => criterion.tests ?? []),
  ]) {
    if (!reference.file?.startsWith('test/') || !fs.existsSync(reference.file) || !reference.test)
      errors.push(`Invalid edge test reference: ${item.id}`);
    else if (results) {
      const suite = results.testResults.find(
        (result) => path.resolve(result.name) === path.resolve(reference.file),
      );
      const assertion = suite?.assertionResults.find(
        (result) => result.title === reference.test || result.fullName === reference.test,
      );
      if (!assertion || assertion.status !== 'passed')
        errors.push(`Edge test did not pass: ${item.id}: ${reference.file}: ${reference.test}`);
    }
  }
}
for (const id of edgeExpected) if (!edgeSeen.has(id)) errors.push(`Missing edge item: ${id}`);
const summary = {
  operations: seen.size,
  criteria: counts,
  incompleteCriteria: gaps,
  edgeItems: edgeSeen.size,
  incompleteEdgeItems: edgeGaps,
  evidenceErrors: errors,
  localAcceptance: gaps === 0 && edgeGaps === 0 && errors.length === 0 && Boolean(results?.success),
};
const output = argument('--output');
if (output) fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (errors.length || (args.includes('--strict') && !summary.localAcceptance)) process.exitCode = 1;
