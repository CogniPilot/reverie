/**
 * @fileoverview The Termux-style terminal row on the Debug terminal view (keyboard-accessory.js), loaded with `vm`
 * against a small fake DOM like test/mobile-shell-keyboard.test.ts. Covers which view gets the row, the bytes each key
 * sends, and the one-shot Alt next to the existing one-shot Ctrl.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserInputFixture } from './helpers/browser-input-fixture.js';

const fixtures: ReturnType<typeof browserInputFixture>[] = [];
afterEach(async () => {for (const fixture of fixtures.splice(0)) await fixture.close();});

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

async function loadBar({ view = 'debug' as string | null, mode = 'claude' } = {}) {
  const attrs: Record<string, string | null> = { 'data-reverie-view': view };
  let observed: (() => void) | undefined;
  const barElement = fakeBarElement(), writes: string[] = [];
  const fixture = browserInputFixture(); fixtures.push(fixture);
  const app = Object.assign(await fixture.page(async (_url, options) => {
    writes.push(JSON.parse(String(options?.body)).input);
    return Response.json({success: true, data: {}});
  }, ['keyboard-accessory.js', 'terminal-ui.js'], {
    mobileDetection: {isTouchDevice: () => true},
    mutationObserver: class {constructor(cb: () => void) {observed = cb;} observe() {}},
    document: {
      addEventListener() {},
      documentElement: {dataset: {}, getAttribute: (name: string) => attrs[name] ?? null},
      createElement: () => barElement,
      querySelector: () => ({parentNode: {insertBefore: vi.fn()}}),
      getElementById: () => null,
    },
  }), {
    activeSessionId: 'session-1', sessions: new Map([['session-1', {mode}]]),
    terminal: {focus: vi.fn()}, insertTerminalText: vi.fn(),
  });
  const bar = fixture.keyboard(app) as Record<string, (...args: unknown[]) => unknown> & {_mode: string};
  bar.init();
  const setView = (next: string | null) => {attrs['data-reverie-view'] = next; observed?.();};
  return {app, bar, barElement, sent: () => writes.slice(), setView};
}

describe('terminal row on the Debug terminal', () => {
  it('shows Esc, Tab, Ctrl, Alt, the four arrows and | / - ~ in the debug view', async () => {
    const { bar, barElement } = await loadBar();
    expect(bar._mode).toBe('terminal');
    expect(barElement.actions).toEqual(['esc', 'tab', 'ctrl', 'alt', 'arrow-left', 'scroll-up', 'scroll-down', 'arrow-right',
      'key-pipe', 'key-slash', 'key-dash', 'key-tilde', 'overflow', 'dismiss']);
    expect(barElement.classList.contains('phone-row')).toBe(true);
  });

  it('leaves the chat view and pages without the chat app on their own bars, and follows a view change', async () => {
    const { bar, setView } = await loadBar({ view: 'chat' });
    expect(bar._mode).not.toBe('terminal');
    setView('debug');
    expect(bar._mode).toBe('terminal');
    setView('chat');
    expect(bar._mode).not.toBe('terminal');
    expect((await loadBar({ view: null })).bar._mode).not.toBe('terminal');
  });

  it('sends what a hardware key would for Esc, Tab and the arrows', async () => {
    const { bar, sent } = await loadBar();
    for (const action of ['esc', 'tab', 'scroll-up', 'scroll-down', 'arrow-right', 'arrow-left']) bar.handleAction(action);
    await expect.poll(sent).toEqual(['\x1b', '\t', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
  });

  it('types | / - ~ at the prompt like typed text', async () => {
    const { app, bar, sent } = await loadBar();
    for (const action of ['key-pipe', 'key-slash', 'key-dash', 'key-tilde']) bar.handleAction(action);
    expect(app.insertTerminalText.mock.calls.map((call: string[]) => call[0])).toEqual(['|', '/', '-', '~']);
    expect(sent()).toEqual([]);
  });
});

describe('one-shot Alt', () => {
  it('sends the next row character with an ESC prefix and disarms', async () => {
    const { app, bar, barElement, sent } = await loadBar();
    bar.handleAction('alt');
    expect(bar.isAltArmed()).toBe(true);
    expect(barElement.querySelector('[data-action="alt"]')!.attrs['aria-pressed']).toBe('true');
    bar.handleAction('key-slash');
    await expect.poll(sent).toEqual(['\x1b/']);
    expect(app.insertTerminalText).not.toHaveBeenCalled();
    expect(bar.isAltArmed()).toBe(false);
  });

  it('applies to a key typed on the system keyboard, and a paste spends it without a prefix', async () => {
    const { bar } = await loadBar();
    bar.toggleAlt();
    expect(bar.isModifierArmed()).toBe(true);
    expect(bar.consumeModifiers('b')).toBe('\x1bb');
    expect(bar.isModifierArmed()).toBe(false);
    bar.toggleAlt();
    expect(bar.consumeModifiers('abc')).toBe('abc');
    expect(bar.isAltArmed()).toBe(false);
    expect(bar.consumeModifiers('x')).toBe('x');  // nothing armed: unchanged
  });

  it('combines with Ctrl: Ctrl and Alt keep each other armed, and Ctrl+Alt+c is ESC then Ctrl+C', async () => {
    const { bar } = await loadBar();
    bar.handleAction('ctrl');
    bar.handleAction('alt');
    expect(bar.isCtrlArmed()).toBe(true);
    expect(bar.isAltArmed()).toBe(true);
    expect(bar.consumeModifiers('c')).toBe('\x1b\x03');
    expect(bar.isModifierArmed()).toBe(false);
  });

  it('is cancelled by a second tap, any other key, a session switch and dismissing the keyboard', async () => {
    const { bar } = await loadBar();
    bar.handleAction('alt');
    bar.handleAction('alt');
    expect(bar.isAltArmed()).toBe(false);
    for (const cancel of [() => bar.handleAction('esc'), () => bar.refreshForActiveSession(), () => bar.hide()]) {
      bar.handleAction('alt');
      bar.handleAction('ctrl');
      cancel();
      await Promise.resolve();
      await expect.poll(() => bar.isModifierArmed()).toBe(false);
      expect(bar.isModifierArmed()).toBe(false);
    }
  });
});
