import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('shows Kanban card reasons in the muted text colour, keeping red for real problems', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/company-board.css'), 'utf8');
  const why = css.match(/\.card \.why\{([^}]*)\}/)![1];
  expect(why).toContain('color:var(--muted)');
  expect(why).not.toContain('--bad');
});
