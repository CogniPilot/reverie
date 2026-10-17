import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function cssRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('terminal layout CSS', () => {
  it('pins the xterm root to the terminal container width while scrollback moves', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
    const xtermRule = cssRuleBody(css, '.terminal-container .xterm');

    expect(xtermRule).toContain('width: 100%');
    expect(xtermRule).toContain('min-width: 0');
  });
});
