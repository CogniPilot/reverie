/**
 * @fileoverview Phone footer chip: shows the open session's folder; the case the next Run uses is the fallback and
 * is stated in the Run sheet. Toasts are clamped to the phone width.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const ui = readFileSync(resolve('src/web/public/session-ui.js'), 'utf8');
const css = readFileSync(resolve('src/web/public/mobile.css'), 'utf8');

function chip(app: Record<string, unknown>) {
  const label = { textContent: '', title: '' };
  const ctx = vm.createContext({ document: { getElementById: (id: string) => (id === 'mobileCaseName' ? label : null) } });
  const methods = vm.runInContext(`(function(){${ui.replace(/^[\s\S]*?(?=\n  updateMobileCaseLabel\()/, 'return {')
    .replace(/\n  async deleteCaseMobile[\s\S]*$/, '}')}})()`, ctx) as Record<string, (...a: unknown[]) => void>;
  const self = Object.assign(app, methods);
  return { label, self };
}

describe('footer folder chip', () => {
  it('shows the active session folder, not the last-used case', () => {
    const { label, self } = chip({ activeSessionId: 's', sessions: new Map([['s', { workingDir: '/home/cto/work/agent-desk/' }]]) });
    (self.updateMobileCaseLabel as (c: string) => void)('smoke-test');
    expect(label.textContent).toBe('agent-desk');
    expect(label.title).toContain('smoke-test');
  });

  it('falls back to the case when no session is open', () => {
    const { label, self } = chip({ activeSessionId: null, sessions: new Map() });
    (self.updateMobileCaseLabel as (c: string) => void)('smoke-test');
    expect(label.textContent).toBe('smoke-test');
  });
});

describe('phone toast', () => {
  it('cannot be wider than the screen', () => {
    expect(css).toMatch(/\.toast\s*\{[^}]*max-width:\s*calc\(100vw - 1rem\)/);
  });
});
