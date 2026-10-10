import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const read = (relative: string) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
function syntax(relative: string) {
  return ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true,
    relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (child: ts.Node) => { result.push(child); ts.forEachChild(child, visit); };
  visit(node);
  return result;
}
function property(name: string): ts.Expression {
  const matches = descendants(syntax('vite.config.ts')).filter(ts.isPropertyAssignment)
    .filter(node => (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name);
  expect(matches, `one explicit Vite ${name} property`).toHaveLength(1);
  return matches[0].initializer;
}

describe('dedicated Connect HTML entry', () => {
  it('loads only its own module entry instead of the main SPA bootstrap', () => {
    const html = read('openchat/connect.html');
    const modules = [...html.matchAll(/<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>/g)];
    expect(modules.map(match => match[1])).toEqual(['/src/connect.tsx']);
    expect(html).not.toMatch(/src\/main|<iframe\b|http-equiv=["']refresh/i);
    const entry = syntax('src/connect.tsx');
    const imports = entry.statements.filter(ts.isImportDeclaration)
      .map(node => (node.moduleSpecifier as ts.StringLiteral).text).sort();
    expect(imports).toEqual(['./features/openchat/LocalConnectPage', './styles/global.css', 'react', 'react-dom/client'].sort());
    const elements = descendants(entry).filter(node => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      .map(node => (node as ts.JsxOpeningElement | ts.JsxSelfClosingElement).tagName.getText());
    expect(elements.map(name => name.replace(/^React\./, '')).sort()).toEqual(['LocalConnectPage', 'StrictMode']);
    expect(descendants(entry).filter(ts.isCallExpression)
      .filter(node => node.expression.kind === ts.SyntaxKind.ImportKeyword)).toEqual([]);
  });

  it('keeps the main HTML and Connect HTML as distinct build inputs', () => {
    const input = property('input');
    expect(ts.isObjectLiteralExpression(input)).toBe(true);
    const files = descendants(input).filter(ts.isStringLiteral).map(node => node.text)
      .filter(value => value.endsWith('.html')).map(value => value.replace(/^\.\//, '')).sort();
    expect(files).toEqual(['index.html', 'openchat/connect.html']);
    expect(read('index.html')).toContain('/src/main.tsx');
  });

  it('does not shadow the stable extensionless alias with a physical asset or directory', () => {
    for (const relative of ['openchat/connect', 'openchat/connect/index.html',
      'public/openchat/connect', 'public/openchat/connect/index.html']) {
      expect(existsSync(new URL(`../../${relative}`, import.meta.url)), relative).toBe(false);
    }
  });

  it('excludes Connect from both service-worker navigation fallback and precaching', () => {
    const denylist = property('navigateFallbackDenylist');
    expect(ts.isArrayLiteralExpression(denylist)).toBe(true);
    const patterns = descendants(denylist).filter(ts.isRegularExpressionLiteral).map(node => {
      const literal = node.getText(), separator = literal.lastIndexOf('/');
      return new RegExp(literal.slice(1, separator), literal.slice(separator + 1));
    });
    expect(patterns.length).toBeGreaterThan(0);
    for (const url of ['/openchat/connect', '/openchat/connect?x=1', '/openchat/connect/extra',
      '/openchat/connect.html', '/openchat/connect.html?x=1', '/openchat/connect.html/extra']) {
      expect(patterns.some(pattern => pattern.test(url)), url).toBe(true);
    }
    for (const url of ['/', '/signin', '/settings', '/openchat/connect.htmlx', '/openchat/connect-other']) {
      expect(patterns.some(pattern => pattern.test(url)), url).toBe(false);
    }
    const ignores = descendants(property('globIgnores')).filter(ts.isStringLiteral).map(node => node.text);
    expect(ignores).toContain('**/openchat/connect.html');
  });
});
