// Check resolved TypeScript imports, including type imports and re-exports.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(process.argv[2] ?? '.');
const sourceRoot = path.join(root, 'src');
const configFile = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
if (!configFile) throw new Error(`Missing tsconfig.json in ${root}`);
const config = ts.readConfigFile(configFile, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile));
if (parsed.errors.length)
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  );
const files = [];
function collect(dir) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, item.name);
    if (item.isDirectory()) collect(name);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) files.push(name);
  }
}
collect(sourceRoot);
if (!files.length) throw new Error('No source files found; boundary check cannot pass empty');
const errors = [];
const segments = (file) => path.relative(sourceRoot, file).split(path.sep);
for (const file of files) {
  const from = segments(file);
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  function check(specifier, node) {
    if (!ts.isStringLiteralLike(specifier)) {
      errors.push(
        `${file}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}: nonliteral import/require is not allowed`,
      );
      return;
    }
    const name = specifier.text;
    const resolved = ts.resolveModuleName(name, file, parsed.options, ts.sys).resolvedModule
      ?.resolvedFileName;
    const target = resolved && path.resolve(resolved);
    const fromDomain = from[0] === 'modules' && from[2] === 'domain';
    if (!target || !target.startsWith(`${sourceRoot}${path.sep}`)) {
      if (fromDomain) errors.push(`${file}: domain cannot import external dependency ${name}`);
      return;
    }
    const to = segments(target);
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const fail = (reason) =>
      errors.push(`${path.relative(root, file)}:${line}: ${name}: ${reason}`);
    if (to[0] === 'modules' && (from[0] !== 'modules' || from[1] !== to[1])) {
      const composition =
        from[0] === 'app-roles' ||
        (from[0] === 'modules' && from.length === 3 && from[2] === `${from[1]}.module.ts`) ||
        (from[0] === 'surfaces' && from.at(-1)?.endsWith('.module.ts'));
      const moduleFile =
        to.length === 3 &&
        (to[2] === `${to[1]}.module.ts` ||
          (to[2]?.startsWith(`${to[1]}-`) && to[2]?.endsWith('.module.ts')));
      if (to[2] !== 'contracts' && !(composition && moduleFile))
        fail('cross-module imports must use contracts; composition roots may import module wiring');
    }
    if (fromDomain) {
      const sameDomain =
        to[0] === 'modules' && to[1] === from[1] && ['domain', 'contracts'].includes(to[2]);
      const commonPure =
        to[0] === 'common' && ['domain', 'money', 'time', 'ids', 'errors'].includes(to[1]);
      if (!sameDomain && !commonPure)
        fail('domain must depend only on its domain/contracts or pure common primitives');
    }
    if (
      from[0] === 'modules' &&
      from[2] === 'application' &&
      ((to[0] === 'modules' && to[1] === from[1] && to[2] === 'infrastructure') ||
        to[0] === 'surfaces' ||
        to[0] === 'platform' ||
        to[0] === 'adapters')
    ) {
      fail('application cannot import infrastructure, platform, adapters or surfaces');
    }
    if (
      from[0] === 'modules' &&
      from[2] === 'contracts' &&
      to[0] === 'modules' &&
      to[1] === from[1] &&
      to[2] !== 'contracts'
    ) {
      fail('contracts cannot re-export or import module internals');
    }
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      check(node.moduleSpecifier, node);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      check(node.argument.literal, node);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    )
      check(node.moduleReference.expression, node);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      if (node.arguments[0]) check(node.arguments[0], node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`Boundary check passed for ${files.length} source files`);
