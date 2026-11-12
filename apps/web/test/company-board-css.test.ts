import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import postcss from 'postcss';

it('shows Kanban card reasons in the muted text colour, keeping red for real problems', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/company-board.css'), 'utf8');
  const reasons: postcss.Rule[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.selectors.includes('.card .why')) reasons.push(rule);
  });
  expect(reasons).toHaveLength(1);
  const colors: string[] = [];
  reasons[0].walkDecls('color', (declaration) => { colors.push(declaration.value); });
  expect(colors).toEqual(['var(--muted)']);
  expect(reasons[0].toString()).not.toContain('--bad');
});
