/**
 * @fileoverview Phone keyboard row: below 600px the accessory bar is ONE row (Esc Tab ↑ ↓ Enter mic ⋯ and the
 * collapse chevron), and everything else sits behind the ⋯ panel. Wider screens keep the agent/shell/extended bars.
 * The bar is a `const` singleton in a classic script, so it is loaded with `vm` like mobile-shell-keyboard.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('src/web/public/keyboard-accessory.js'), 'utf8');

type Bar = {
  _phoneButtons: string;
  _resolveMode(): string;
  _overflowItems(shell: boolean): string[][];
};

function load(opts: { phone: boolean; sessionMode?: string }): Bar {
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches: opts.phone }) },
    app: { activeSessionId: 's', sessions: new Map([['s', { mode: opts.sessionMode ?? 'claude' }]]) },
    document: { getElementById: () => ({ textContent: 'agent-work' }) },
    MobileDetection: { isTouchDevice: () => true },
  });
  vm.runInContext(`${source}\nglobalThis.__bar = KeyboardAccessoryBar;`, context, { filename: 'keyboard-accessory.js' });
  return (context as unknown as { __bar: Bar }).__bar;
}

const actionsOf = (html: string) => [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);

describe('phone keyboard row', () => {
  it('is one row: Esc Tab up down Enter mic, the overflow, and the collapse chevron', () => {
    expect(actionsOf(load({ phone: true })._phoneButtons)).toEqual([
      'esc', 'tab', 'scroll-up', 'scroll-down', 'enter', 'voice', 'overflow', 'dismiss',
    ]);
  });

  it('is chosen below 600px for agent and shell sessions, and not on wider screens', () => {
    expect(load({ phone: true, sessionMode: 'claude' })._resolveMode()).toBe('phone');
    expect(load({ phone: true, sessionMode: 'shell' })._resolveMode()).toBe('phone');
    expect(load({ phone: false, sessionMode: 'claude' })._resolveMode()).toBe('simple');
    expect(load({ phone: false, sessionMode: 'shell' })._resolveMode()).toBe('shell');
  });

  it('keeps every action that left the row behind the overflow', () => {
    const bar = load({ phone: true });
    const agent = bar._overflowItems(false).map((i) => i[0]);
    expect(agent).toEqual(expect.arrayContaining(['init', 'compose', 'attach', 'run-shell', 'case', 'stop', 'settings']));
    const shell = bar._overflowItems(true).map((i) => i[0]);
    expect(shell).toEqual(expect.arrayContaining(['ctrl', 'arrow-left', 'arrow-right', 'paste', 'attach', 'run-shell', 'case', 'stop', 'settings']));
    expect(shell).not.toContain('init');
  });

  it('labels the folder entry with the footer case name', () => {
    expect(load({ phone: true })._overflowItems(false).find((i) => i[0] === 'case')?.[1]).toBe('agent-work');
  });
});
