import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const composition = new Set(['api-main.ts', 'worker-main.ts', 'runtime.ts', 'memory/index.ts',
  'listening/backfill-archive.ts', 'listening/purge-archived-transcripts.ts', 'persistence/purge-chat-text.ts']);

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]))).flat();
}

test('application code accesses databases only through repositories', async () => {
  const violations: string[] = [];
  for (const file of await files(source)) {
    const name = relative(source, file);
    if (!file.endsWith('.ts') || name.startsWith('db/')) continue;
    const code = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const checkImport = (specifier: string, typeOnly: boolean) => {
      if (/^(drizzle-orm(?:\/|$)|pg$|@libsql\/client(?:\/|$))/.test(specifier)) violations.push(`${name}: imports database driver/ORM ${specifier}`);
      if (!specifier.startsWith('.')) return;
      const target = relative(source, resolve(dirname(file), specifier));
      if (!target.startsWith('db/')) return;
      if (target.startsWith('db/repositories/')) return;
      if (typeOnly && (target.startsWith('db/entities/') || target === 'db/schema.js')) return;
      if (composition.has(name) && target === 'db/client.js') return;
      violations.push(`${name}: bypasses repositories via ${specifier}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const typeOnly = !!clause?.isTypeOnly || (!!clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          && !clause.name && clause.namedBindings.elements.every(item => item.isTypeOnly));
        checkImport(node.moduleSpecifier.text, typeOnly);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkImport(node.moduleSpecifier.text, node.isTypeOnly);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(code) === 'require')) {
        const specifier = node.arguments[0];
        if (specifier && ts.isStringLiteral(specifier)) checkImport(specifier.text, false);
      }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node))
        && /^\s*(?:SELECT\b[\s\S]*\bFROM\b|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+TABLE\b)/i.test(node.text)) {
        violations.push(`${name}: contains an inline database statement`);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression.getText(code);
        if (/^(?:db|tx|pool|client)$|\.db$|\.pool$/.test(receiver)
          && /^(?:select|selectDistinct|selectDistinctOn|insert|update|delete|execute|query|transaction|batch|run|all)$/.test(node.expression.name.text)) {
          violations.push(`${name}: calls ${receiver}.${node.expression.name.text} directly`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(code);
  }
  assert.deepEqual(violations, [], 'Keep queries, entities and driver calls inside src/db; expose domain repository operations.');
});
