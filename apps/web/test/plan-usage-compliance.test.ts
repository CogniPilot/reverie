import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionUsageReader } from '../src/subscription-usage.js';

// A source regression tripwire, backed by a runtime check below. This is not
// a general JavaScript information-flow proof or a provider-policy verdict.
// The authorized read-only Claude adapter has its own behavioral security tests;
// credential handling stays out of telemetry ingestion, storage, and routing.
const guardedFiles = [
  'src/plan-accounts.ts',
  'src/subscription-usage.ts',
  'src/plan-pace.ts',
  'src/usage-telemetry.ts',
  'src/web/plan-usage-latest.ts',
  'src/web/routes/plans-routes.ts',
  'src/web/routes/status-telemetry-routes.ts',
];

function violations(source: string): string[] {
  const tree = ts.createSourceFile('guard.ts', source, ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      if (/\bBearer\b/i.test(value)) failures.push('Bearer authentication');
      if (/(?:^|[./])anthropic\.com\b/i.test(value)) failures.push('Anthropic endpoint');
      if (/(?:\.credentials\.json|auth\.json|claudeAiOauth|accessToken|refreshToken)/i.test(value)) {
        // Existence and mtime checks remain allowed. A credential path anywhere
        // else (including in a variable initializer) requires explicit review.
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isCallExpression(parent) && !ts.isStatement(parent)) parent = parent.parent;
        // join()/resolve() may wrap a path used by the metadata operation.
        while (parent && ts.isCallExpression(parent) && /^(?:join|resolve)$/.test(parent.expression.getText(tree))) {
          parent = parent.parent;
          while (parent && !ts.isCallExpression(parent) && !ts.isStatement(parent)) parent = parent.parent;
        }
        const method = parent && ts.isCallExpression(parent) ? parent.expression.getText(tree) : '';
        if (!/^(?:fs\.)?(?:stat|access|statSync|accessSync)$/.test(method)) failures.push('credential content path');
      }
    }
    if (ts.isIdentifier(node) && /^(?:claudeAiOauth|accessToken|refreshToken)$/.test(node.text)) {
      failures.push('credential token field');
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return failures;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('plan usage subscription boundary', () => {
  it.each(guardedFiles)('%s consumes telemetry without credential or Anthropic request code', (file) => {
    expect(violations(readFileSync(resolve(import.meta.dirname, '..', file), 'utf8'))).toEqual([]);
  });

  it.each([
    "await fs.readFile(join(dir, '.credentials.json'), 'utf8')",
    "await fs.open(join(dir, '.credentials.json'))",
    "createReadStream(join(dir, '.credentials.json'))",
    "const file = join(dir, '.credentials.json'); await fs.readFile(file)",
    "const headers = { Authorization: 'Bearer secret' }",
    "fetch('https://api.anthropic.com/api/oauth/usage')",
    "fetch('https://api.\\u0061nthropic.com/api/oauth/usage')",
    'const token = data.claudeAiOauth.accessToken',
  ])('rejects a forbidden regression: %s', (mutation) => {
    expect(violations(mutation).length).toBeGreaterThan(0);
  });

  it('allows login metadata checks and reading our own usage history', () => {
    expect(
      violations(`
      await fs.stat(join(dir, '.credentials.json'));
      await fs.access(join(dir, '.credentials.json'));
      await fs.readFile(historyFile, 'utf8');
    `)
    ).toEqual([]);
  });

  it('a signed-out Claude reader never opens credentials or fetches', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ mtimeMs: 123 } as Awaited<ReturnType<typeof fs.stat>>);
    vi.spyOn(fs, 'access').mockResolvedValue(undefined);
    const read = vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('credential reads prohibited'));
    const open = vi.spyOn(fs, 'open').mockRejectedValue(new Error('credential opens prohibited'));
    const fetcher = vi.fn(() => {
      throw new Error('network prohibited');
    });
    vi.stubGlobal('fetch', fetcher);
    const reading = await new SubscriptionUsageReader('guard', async () => 'signed-out').read({
      id: 'guard-claude',
      label: 'guard',
      provider: 'anthropic',
      configDir: '/nonexistent/guard-claude',
      openCodeDataDir: '/nonexistent/guard-opencode',
    });
    expect(reading).toMatchObject({ status: 'signed-out', usage: null });
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
