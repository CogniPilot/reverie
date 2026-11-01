/**
 * @fileoverview The Termux-style terminal row on the Debug terminal view (keyboard-accessory.js), loaded with `vm`
 * against a small fake DOM like test/mobile-shell-keyboard.test.ts. Covers which view gets the row, the bytes each key
 * sends, and the one-shot Alt next to the existing one-shot Ctrl.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const keyboardSource = readFileSync(resolve('src/web/public/keyboard-accessory.js'), 'utf8');

type FakeButton = { dataset: { action: string }; classList: { has: Set<string>; toggle(n: string, on: boolean): void }; attrs: Record<string, string>; setAttribute(n: string, v: string): void };

function fakeBarElement() {
  let buttons = new Map<string, FakeButton>();
  const classes = new Set<string>();
  return {
    className: '',
    style: {},
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    set innerHTML(next: string) {
      buttons = new Map();
      for (const match of next.matchAll(/data-action="([^"]+)"/g)) {
        const has = new Set<string>();
        buttons.set(match[1], {
          dataset: { action: match[1] },
          classList: { has, toggle: (n: string, on: boolean) => (on ? has.add(n) : has.delete(n)) },
          attrs: {},
          setAttribute(n: string, v: string) { this.attrs[n] = v; },
        });
      }
    },
    get actions() { return [...buttons.keys()]; },
    querySelector(selector: string) {
      const match = /\[data-action="([^"]+)"\]/.exec(selector);
      return match ? (buttons.get(match[1]) ?? null) : null;
    },
    addEventListener: vi.fn(),
  };
}

function loadBar({ view = 'debug' as string | null, mode = 'claude' } = {}) {
  const attrs: Record<string, string | null> = { 'data-reverie-view': view };
  let observed: (() => void) | undefined;
  const app = {
    activeSessionId: 'session-1',
    sessions: new Map([['session-1', { mode }]]),
    terminal: { focus: vi.fn() },
    insertTerminalText: vi.fn(),
  };
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
  const barElement = fakeBarElement();
  const context = vm.createContext({
    app,
    MobileDetection: { isTouchDevice: () => true },
    URLSearchParams,
    fetch: fetchMock,
    MutationObserver: class { constructor(cb: () => void) { observed = cb; } observe() {} },
    document: {
      documentElement: { getAttribute: (name: string) => attrs[name] ?? null },
      createElement: () => barElement,
      querySelector: () => ({ parentNode: { insertBefore: vi.fn() } }),
      getElementById: () => null,
    },
    setTimeout: (fn: () => void) => { fn(); return 1; },
    clearTimeout: vi.fn(),
  });
  vm.runInContext(`${keyboardSource}\nglobalThis.__bar = KeyboardAccessoryBar;`, context, { filename: 'keyboard-accessory.js' });
  const bar = (context as unknown as { __bar: Record<string, (...args: unknown[]) => unknown> & { _mode: string } }).__bar;
  bar.init();
  const sent = () => (fetchMock.mock.calls as unknown as [string, { body: string }][]).map(call => JSON.parse(call[1].body).input);
  const setView = (next: string | null) => { attrs['data-reverie-view'] = next; observed?.(); };
  return { app, bar, barElement, sent, setView };
}

describe('terminal row on the Debug terminal', () => {
  it('shows Esc, Tab, Ctrl, Alt, the four arrows and | / - ~ in the debug view', () => {
    const { bar, barElement } = loadBar();
    expect(bar._mode).toBe('terminal');
    expect(barElement.actions).toEqual(['esc', 'tab', 'ctrl', 'alt', 'arrow-left', 'scroll-up', 'scroll-down', 'arrow-right',
      'key-pipe', 'key-slash', 'key-dash', 'key-tilde', 'overflow', 'dismiss']);
    expect(barElement.classList.contains('phone-row')).toBe(true);
  });

  it('leaves the chat view and pages without the chat app on their own bars, and follows a view change', () => {
    const { bar, setView } = loadBar({ view: 'chat' });
    expect(bar._mode).not.toBe('terminal');
    setView('debug');
    expect(bar._mode).toBe('terminal');
    setView('chat');
    expect(bar._mode).not.toBe('terminal');
    expect(loadBar({ view: null }).bar._mode).not.toBe('terminal');
  });

  it('sends what a hardware key would for Esc, Tab and the arrows', () => {
    const { bar, sent } = loadBar();
    for (const action of ['esc', 'tab', 'scroll-up', 'scroll-down', 'arrow-right', 'arrow-left']) bar.handleAction(action);
    expect(sent()).toEqual(['\x1b', '\t', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
  });

  it('types | / - ~ at the prompt like typed text', () => {
    const { app, bar, sent } = loadBar();
    for (const action of ['key-pipe', 'key-slash', 'key-dash', 'key-tilde']) bar.handleAction(action);
    expect(app.insertTerminalText.mock.calls.map((call: string[]) => call[0])).toEqual(['|', '/', '-', '~']);
    expect(sent()).toEqual([]);
  });
});

describe('one-shot Alt', () => {
  it('sends the next row character with an ESC prefix and disarms', () => {
    const { app, bar, barElement, sent } = loadBar();
    bar.handleAction('alt');
    expect(bar.isAltArmed()).toBe(true);
    expect(barElement.querySelector('[data-action="alt"]')!.attrs['aria-pressed']).toBe('true');
    bar.handleAction('key-slash');
    expect(sent()).toEqual(['\x1b/']);
    expect(app.insertTerminalText).not.toHaveBeenCalled();
    expect(bar.isAltArmed()).toBe(false);
  });

  it('applies to a key typed on the system keyboard, and a paste spends it without a prefix', () => {
    const { bar } = loadBar();
    bar.toggleAlt();
    expect(bar.isModifierArmed()).toBe(true);
    expect(bar.consumeModifiers('b')).toBe('\x1bb');
    expect(bar.isModifierArmed()).toBe(false);
    bar.toggleAlt();
    expect(bar.consumeModifiers('abc')).toBe('abc');
    expect(bar.isAltArmed()).toBe(false);
    expect(bar.consumeModifiers('x')).toBe('x');  // nothing armed: unchanged
  });

  it('combines with Ctrl: Ctrl and Alt keep each other armed, and Ctrl+Alt+c is ESC then Ctrl+C', () => {
    const { bar } = loadBar();
    bar.handleAction('ctrl');
    bar.handleAction('alt');
    expect(bar.isCtrlArmed()).toBe(true);
    expect(bar.isAltArmed()).toBe(true);
    expect(bar.consumeModifiers('c')).toBe('\x1b\x03');
    expect(bar.isModifierArmed()).toBe(false);
  });

  it('is cancelled by a second tap, any other key, a session switch and dismissing the keyboard', () => {
    const { bar } = loadBar();
    bar.handleAction('alt');
    bar.handleAction('alt');
    expect(bar.isAltArmed()).toBe(false);
    for (const cancel of [() => bar.handleAction('esc'), () => bar.refreshForActiveSession(), () => bar.hide()]) {
      bar.handleAction('alt');
      bar.handleAction('ctrl');
      cancel();
      expect(bar.isModifierArmed()).toBe(false);
    }
  });
});
