/**
 * @fileoverview Shell-specific mobile keyboard bar and its one-shot Ctrl
 * modifier (issue #262).
 *
 * The bar is a `const` singleton in a non-module script, so it is loaded with
 * `vm` against a small fake DOM (no jsdom in this repo), the same approach as
 * test/path-picker-ui.test.ts. What matters here is the state machine: which
 * layout a session gets, when the modifier arms, what byte a keystroke turns
 * into, and every path that must disarm it. Behavior against a real shell
 * (Ctrl+C reaching the PTY) is covered in test/mobile/keyboard.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import {ZerolagInputAddon} from '../packages/xterm-zerolag-input/src/zerolag-input-addon.js';
import { browserInputFixture, type InputFetch, type RawInputBuffer } from './helpers/browser-input-fixture.js';
import { frontendDeclarations } from './helpers/frontend-declarations.js';
const inputFixtures: ReturnType<typeof browserInputFixture>[] = [];
afterEach(async () => {for (const fixture of inputFixtures.splice(0)) await fixture.close();});

const publicRoot = resolve(import.meta.dirname, '../src/web/public');
const keyboardSource = readFileSync(resolve(publicRoot, 'keyboard-accessory.js'), 'utf8');
const terminalSource = readFileSync(resolve(publicRoot, 'terminal-ui.js'), 'utf8');

type TerminalInput = { isTerminalFocusOrMouseReport(data: string): boolean };
type TerminalModule = {
  terminalInput: TerminalInput;
  ReverieApp: { prototype: Record<string, (...args: never[]) => unknown> };
  bar: Bar;
};
let terminalModule: TerminalModule | null = null;

/**
 * terminal-ui.js in a vm, with the REAL accessory bar in the same script scope
 * (it is a `const` singleton, so only a shared scope makes the bare
 * `KeyboardAccessoryBar` reference in the CJK path resolve). Its IIFE only
 * needs a window to hang `ReverieTerminalInput` on, but the rest of the file
 * assigns to ReverieApp.prototype at top level, so constants.js + app.js load
 * first — the same recipe as test/local-echo-codex-gating.test.ts.
 */
function loadTerminalModule(): TerminalModule {
  if (terminalModule) return terminalModule;
  const read = (file: string) => readFileSync(resolve(publicRoot, file), 'utf8');
  const windowStub: Record<string, unknown> = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const context = vm.createContext({
    console,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    URLSearchParams,
    document: { addEventListener: vi.fn(), documentElement: { dataset: {} }, getElementById: () => null },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: windowStub,
    MobileDetection: { isTouchDevice: () => true, isHandheldDevice: () => false, getDeviceType: () => 'desktop' },
  });
  vm.runInContext(
    `${read('constants.js')}\n${keyboardSource}\n${read('app.js')}\n${terminalSource}\n` +
      `globalThis.__ReverieApp = ReverieApp; globalThis.__bar = KeyboardAccessoryBar;`,
    context
  );
  const exported = context as unknown as { __ReverieApp: TerminalModule['ReverieApp']; __bar: Bar };
  terminalModule = {
    terminalInput: (windowStub as { ReverieTerminalInput?: TerminalInput }).ReverieTerminalInput!,
    ReverieApp: exported.__ReverieApp,
    bar: exported.__bar,
  };
  return terminalModule;
}

function loadTerminalInput(): TerminalInput {
  return loadTerminalModule().terminalInput;
}

type FakeButton = {
  dataset: { action: string };
  classList: { has: Set<string>; toggle(name: string, on: boolean): void; contains(name: string): boolean };
  attrs: Record<string, string>;
  setAttribute(name: string, value: string): void;
};

function fakeButton(action: string): FakeButton {
  const has = new Set<string>();
  return {
    dataset: { action },
    classList: {
      has,
      toggle(name: string, on: boolean) {
        if (on) has.add(name);
        else has.delete(name);
      },
      contains: (name: string) => has.has(name),
    },
    attrs: {},
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
  };
}

/** Fake bar element: tracks the button set parsed out of the assigned HTML. */
function fakeBarElement() {
  let html = '';
  let buttons = new Map<string, FakeButton>();
  const classes = new Set<string>();
  return {
    className: '',
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
      // init() calls syncReadMyMind(), which toggles the 🧠 marker class on the
      // bar with an explicit force argument.
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(next: string) {
      html = next;
      buttons = new Map();
      for (const match of next.matchAll(/data-action="([^"]+)"/g)) {
        buttons.set(match[1], fakeButton(match[1]));
      }
    },
    get actions() {
      return [...buttons.keys()];
    },
    querySelector(selector: string) {
      const match = /\[data-action="([^"]+)"\]/.exec(selector);
      return match ? (buttons.get(match[1]) ?? null) : null;
    },
    addEventListener: vi.fn(),
  };
}

type Bar = {
  element: ReturnType<typeof fakeBarElement>;
  _mode: string;
  init(): void;
  setMode(mode: string): void;
  refreshForActiveSession(): void;
  handleAction(action: string, btn?: unknown): void;
  isCtrlArmed(): boolean;
  toggleCtrl(): void;
  clearCtrl(): void;
  consumeCtrl(data: string): string;
  ctrlByteFor(char: string): string | null;
  hide(): void;
  show(): void;
};

function loadBar(sessionMode = 'claude', existing?: {activeSessionId: string; sessions: Map<string, {mode: string}>; terminal: {focus(): void}}) {
  const app = existing || {
    activeSessionId: 'session-1',
    sessions: new Map<string, { mode: string }>([['session-1', { mode: sessionMode }]]),
    terminal: { focus: vi.fn() },
  };
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, catch: () => {} }));
  const barElement = fakeBarElement();
  const context = vm.createContext({
    app,
    MobileDetection: { isTouchDevice: () => true },
    URLSearchParams,
    fetch: fetchMock,
    document: {
      createElement: () => barElement,
      querySelector: () => ({ parentNode: { insertBefore: vi.fn() } }),
    },
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: vi.fn(),
  });
  vm.runInContext(`${keyboardSource}\nglobalThis.__bar = KeyboardAccessoryBar;`, context, {
    filename: 'keyboard-accessory.js',
  });
  const bar = (context as unknown as { __bar: Bar }).__bar;
  bar.init();
  return { app, bar, barElement, fetchMock };
}

async function barWithDraft(
  draft: string,
  respond: InputFetch = async () => Response.json({ success: true, data: {} })
) {
  const fixture = browserInputFixture();
  inputFixtures.push(fixture);
  const effect = vi.fn(respond);
  const actual = await fixture.page(effect, ['terminal-ui.js']);
  const app = Object.assign(actual, {
    activeSessionId: 'session-1',
    sessions: new Map([['session-1', { mode: 'claude' }]]),
    terminal: { focus: vi.fn() },
  });
  const loaded = loadBar('claude', app);
  const overlay = new ZerolagInputAddon();
  overlay.appendText(draft);
  overlay.setFlushed(3, 'dra');
  vi.spyOn(overlay, 'clear');
  vi.spyOn(overlay, 'suppressBufferDetection');
  Object.assign(app, {
    _localEchoEnabled: true,
    _localEchoOverlay: overlay,
    _flushedOffsets: new Map([['session-1', 3]]),
    _flushedTexts: new Map([['session-1', 'dra']]),
  });
  return { ...loaded, app: app as typeof app & Record<string, unknown>, overlay, fetchMock: effect, fixture };
}

describe('ctrlByteFor: character to control byte', () => {
  const { bar } = loadBar();

  it.each([
    ['c', '\x03'], // interrupt
    ['d', '\x04'], // EOF
    ['z', '\x1a'], // suspend
    ['r', '\x12'], // reverse search
    ['l', '\x0c'], // clear
    ['a', '\x01'],
    ['e', '\x05'],
    ['w', '\x17'],
    ['u', '\x15'],
    ['k', '\x0b'],
  ])('maps %s to its control byte', (char, byte) => {
    expect(bar.ctrlByteFor(char)).toBe(byte);
  });

  it('maps uppercase the same as lowercase (Ctrl+C == Ctrl+c)', () => {
    expect(bar.ctrlByteFor('C')).toBe('\x03');
    expect(bar.ctrlByteFor('D')).toBe('\x04');
  });

  it('maps the punctuation controls a terminal defines', () => {
    expect(bar.ctrlByteFor('@')).toBe('\x00');
    expect(bar.ctrlByteFor('[')).toBe('\x1b'); // Ctrl+[ is Escape
    expect(bar.ctrlByteFor('\\')).toBe('\x1c');
    expect(bar.ctrlByteFor(']')).toBe('\x1d');
    expect(bar.ctrlByteFor('^')).toBe('\x1e');
    expect(bar.ctrlByteFor('_')).toBe('\x1f');
    expect(bar.ctrlByteFor(' ')).toBe('\x00'); // Ctrl+Space = NUL
    expect(bar.ctrlByteFor('?')).toBe('\x7f'); // Ctrl+? = DEL
  });

  it('returns null for characters with no control equivalent', () => {
    // A hardware keyboard types these straight through under Ctrl.
    for (const char of ['1', '9', '.', ',', '/', '-', '=', 'é']) {
      expect(bar.ctrlByteFor(char)).toBeNull();
    }
    expect(bar.ctrlByteFor('ab')).toBeNull();
    expect(bar.ctrlByteFor('')).toBeNull();
  });
});

describe('shell keyboard bar selection', () => {
  it('gives a shell session the terminal bar', () => {
    const { bar, barElement } = loadBar('shell');
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('shell');
    expect(barElement.actions).toEqual([
      'ctrl',
      'esc',
      'tab',
      'scroll-up',
      'scroll-down',
      'arrow-left',
      'arrow-right',
      'paste',
      'dismiss',
    ]);
  });

  it.each(['claude', 'codex', 'opencode', 'gemini', 'antigravity'])('leaves a %s session on the agent bar', (mode) => {
    const { bar, barElement } = loadBar(mode);
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('simple');
    expect(barElement.actions).toContain('init');
    expect(barElement.actions).not.toContain('ctrl');
  });

  it('remembers the extended-bar preference across a shell session', () => {
    const { app, bar, barElement } = loadBar('claude');
    bar.setMode('extended');
    expect(bar._mode).toBe('extended');

    app.sessions.set('shell-1', { mode: 'shell' });
    app.activeSessionId = 'shell-1';
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('shell');

    // Settings saved while the shell bar is up must not yank it away...
    bar.setMode('extended');
    expect(bar._mode).toBe('shell');

    // ...and switching back to the agent session restores the user's choice.
    app.activeSessionId = 'session-1';
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('extended');
    expect(barElement.actions).toContain('compact');
  });

  it('falls back to the agent bar with no active session', () => {
    const { app, bar } = loadBar('shell');
    app.activeSessionId = null as unknown as string;
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('simple');
  });
});

describe('one-shot Ctrl modifier', () => {
  function shellBar() {
    const loaded = loadBar('shell');
    loaded.bar.refreshForActiveSession();
    return loaded;
  }

  it('is disarmed until the Ctrl key is tapped', () => {
    const { bar } = shellBar();
    expect(bar.isCtrlArmed()).toBe(false);
    expect(bar.consumeCtrl('c')).toBe('c');
  });

  it('arms visibly and rewrites the next character as its control byte', () => {
    const { bar, barElement } = shellBar();
    bar.handleAction('ctrl');

    expect(bar.isCtrlArmed()).toBe(true);
    const button = barElement.querySelector('[data-action="ctrl"]')!;
    expect(button.classList.contains('armed')).toBe(true);
    expect(button.attrs['aria-pressed']).toBe('true');

    expect(bar.consumeCtrl('c')).toBe('\x03');

    // One shot: spent, and the button says so.
    expect(bar.isCtrlArmed()).toBe(false);
    expect(button.classList.contains('armed')).toBe(false);
    expect(button.attrs['aria-pressed']).toBe('false');
    expect(bar.consumeCtrl('c')).toBe('c');
  });

  it('sends Ctrl+D for the next key too', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.consumeCtrl('d')).toBe('\x04');
  });

  it('cancels on a second tap of Ctrl', () => {
    const { bar, barElement } = shellBar();
    bar.handleAction('ctrl');
    bar.handleAction('ctrl');
    expect(bar.isCtrlArmed()).toBe(false);
    expect(barElement.querySelector('[data-action="ctrl"]')!.classList.contains('armed')).toBe(false);
    expect(bar.consumeCtrl('c')).toBe('c');
  });

  it('passes a character with no control byte through unchanged, spending the modifier', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.consumeCtrl('7')).toBe('7');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('spends the modifier on a paste instead of leaving it armed for the next keystroke', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.consumeCtrl('git status')).toBe('git status');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('is cancelled by any other accessory key', async () => {
    const {bar, app} = await barWithDraft('');
    bar.handleAction('ctrl');
    bar.handleAction('esc');
    expect(bar.isCtrlArmed()).toBe(false);
    await app._inputAcceptTail;
    await app._drainSession('session-1');
  });

  it('is cancelled by a session switch', () => {
    const { app, bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.isCtrlArmed()).toBe(true);

    app.sessions.set('shell-2', { mode: 'shell' });
    app.activeSessionId = 'shell-2';
    bar.refreshForActiveSession();

    // Same layout, but the modifier must not survive into the next session.
    expect(bar._mode).toBe('shell');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('is cancelled when the keyboard is dismissed', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    bar.hide();
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('drops the armed state when the layout is swapped out from under it', () => {
    const { app, bar } = shellBar();
    bar.handleAction('ctrl');
    app.sessions.set('agent-1', { mode: 'claude' });
    app.activeSessionId = 'agent-1';
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('simple');
    expect(bar.isCtrlArmed()).toBe(false);
    expect(bar.consumeCtrl('c')).toBe('c');
  });
});

describe('terminal input wiring', () => {
  /** Extract the shipped lexical closure and its actual onData registration.
   * The fixture supplies xterm's event emitter, not a copy of the input router. */
  function bindOnData(app: object, bar: Bar) {
    const source = ts.createSourceFile(
      'terminal-ui.js',
      terminalSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const owners: ts.MethodDeclaration[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'initTerminal')
        owners.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (owners.length !== 1 || !owners[0].body) throw new Error('Expected actual initTerminal lexical owner');
    const statements = owners[0].body.statements;
    const declarations = statements
      .filter(ts.isVariableStatement)
      .map((node) => node.getText(source))
      .join('\n');
    const closure = frontendDeclarations(declarations, [
      'createInputOwner',
      'inputOwner',
      'flushInput',
      'retainRawAction',
      'handleTerminalData',
    ]);
    const registrations = statements.filter((statement) => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
      const callee = statement.expression.expression;
      return (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'onData' &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === 'terminal' &&
        callee.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      );
    });
    if (registrations.length !== 1) throw new Error('Expected one actual terminal.onData registration');
    new Function(
      'KeyboardAccessoryBar',
      'window',
      'document',
      'performance',
      `${closure}\n${registrations[0].getText(source)}`
    ).call(
      app,
      bar,
      { cjkActive: false, ReverieTerminalInput: loadTerminalInput() },
      { activeElement: null, getElementById: () => null },
      performance
    );
  }

  it.each(['plain', 'predictive', 'local-echo'])(
    'filters query replies before applying modifiers in actual %s onData',
    async (mode) => {
      const fixture = browserInputFixture();
      inputFixtures.push(fixture);
      const sent: string[] = [];
      const app = Object.assign(
        await fixture.page(
          async (_url, options) => {
            sent.push(JSON.parse(String(options?.body)).input);
            return Response.json({ success: true, data: {} });
          },
          ['keyboard-accessory.js', 'terminal-ui.js']
        ),
        {
          sessions: new Map([['session-1', { id: 'session-1', mode: 'shell' }]]),
          terminal: { focus: vi.fn(), options: {}, onData: vi.fn<(listener: (text: string) => void) => void>() },
          _localEchoEnabled: mode === 'local-echo',
          _localEchoOverlay: new ZerolagInputAddon(),
          _localEchoPolicy: mode === 'predictive' ? 'predict' : 'off',
          _predictHookOnData: vi.fn(),
          _consumeMobileImeTerminalData: () => false,
          _keyCode229Recovery: { notifyCanonicalData: vi.fn() },
          _flushedOffsets: new Map(),
          _flushedTexts: new Map(),
          _pendingInput: '',
          _inputFlushTimeout: null,
          _lastKeystrokeTime: 0,
          _pendingInputOwner: undefined as RawInputBuffer | undefined,
          _inputAcceptTail: undefined as Promise<unknown> | undefined,
          _terminalDraftTail: undefined as Promise<unknown> | undefined,
        }
      );
      const bar = fixture.keyboard(app) as Bar;
      bar.element = fakeBarElement();
      bar.refreshForActiveSession();
      bindOnData(app, bar);
      expect(app.terminal.onData).toHaveBeenCalledTimes(1);
      const emit = app.terminal.onData.mock.calls[0][0];
      async function settle() {
        await app._pendingInputOwner?.flush();
        await app._terminalDraftTail;
        await app._inputAcceptTail;
        await expect
          .poll(async () => {
            await app._drainSession('session-1');
            await app._inputOutcomes.get('session-1');
            const stored = await app._inputJournal.snapshot();
            return {
              pending: app._pendingDeliveries.get('session-1') || [],
              flights: app._inputFlights.size,
              records: stored.records,
              retained: stored.retained,
              holds: stored.holds,
            };
          })
          .toEqual({ pending: [], flights: 0, records: [], retained: [], holds: [] });
      }
      bar.handleAction('ctrl');
      for (const reply of ['\x1b[?1;2c', '\x1b[12;34R']) {
        emit(reply);
        await settle();
        expect(sent).toEqual([]);
        expect(bar.isCtrlArmed()).toBe(true);
        expect(app._keyCode229Recovery.notifyCanonicalData).not.toHaveBeenCalled();
      }
      const reports = ['\x1b[I', '\x1b[<0;10;5M'];
      for (const report of reports) {
        emit(report);
        await settle();
        expect(bar.isCtrlArmed()).toBe(true);
        expect(app._keyCode229Recovery.notifyCanonicalData).not.toHaveBeenCalled();
      }
      expect(sent).toEqual(reports);
      if (mode === 'local-echo') app._localEchoOverlay.appendText('draft');
      emit('c');
      await settle();
      const original = [...reports, ...(mode === 'local-echo' ? ['draft'] : []), '\x03'];
      expect(sent).toEqual(original);
      expect(bar.isCtrlArmed()).toBe(false);
      expect(app._keyCode229Recovery.notifyCanonicalData).toHaveBeenCalledTimes(1);
      expect(app._predictHookOnData.mock.calls.flat()).not.toContain('c');
      expect(app._localEchoOverlay.pendingText).toBe('');
      app._redeliverSweep();
      await settle();
      expect(sent).toEqual(original);
      emit('z');
      await settle();
      if (mode === 'local-echo') {
        expect(app._localEchoOverlay.pendingText).toBe('z');
        expect(sent).toEqual(original);
        emit('\r');
        await settle();
        original.push('z', '\r');
        expect(app._localEchoOverlay.pendingText).toBe('');
      } else {
        expect(app._predictHookOnData).toHaveBeenCalledWith('z');
        original.push('z');
      }
      expect(sent).toEqual(original);
      app._redeliverSweep();
      await settle();
      expect(sent).toEqual(original);
    }
  );

  it('guards the hook so a page without the bar (desktop) still types normally', () => {
    expect(terminalSource).toContain("typeof KeyboardAccessoryBar !== 'undefined'");
  });

  it('skips terminal-generated focus and mouse reports', () => {
    // Pins the gate itself: without it the modifier is spent by the `\x1b[I`
    // that the Ctrl button's own refocus emits (see the describe below).
    expect(terminalSource).toContain('!window.ReverieTerminalInput?.isTerminalFocusOrMouseReport(data)');
  });
});

describe('ReverieTerminalInput.isTerminalFocusOrMouseReport', () => {
  const isReport = loadTerminalInput().isTerminalFocusOrMouseReport;

  it.each([
    ['\x1b[I', 'focus in (DECSET 1004)'],
    ['\x1b[O', 'focus out (DECSET 1004)'],
    ['\x1b[<0;10;5M', 'SGR mouse press'],
    ['\x1b[<0;10;5m', 'SGR mouse release'],
    ['\x1b[<64;10;5M', 'SGR wheel up'],
    ['\x1b[M !!', 'legacy X10 mouse'],
  ])('classifies %j as terminal-generated (%s)', (data) => {
    expect(isReport(data)).toBe(true);
  });

  it.each([
    ['c', 'a typed character'],
    ['\x03', 'a control byte'],
    ['\r', 'Enter'],
    ['\x1b', 'the Escape key'],
    ['\x1b[A', 'an arrow key'],
    ['\x1b[200~hi\x1b[201~', 'a bracketed paste'],
    ['\x1b[?1;2c', 'a DA reply'],
    ['I', 'the letter I'],
  ])('leaves %j alone (%s)', (data) => {
    expect(isReport(data)).toBe(false);
  });
});

describe('one-shot Ctrl vs terminal-generated reports', () => {
  // The onData gate, as terminal-ui.js writes it. The wiring test above pins
  // the real source; this proves the behavior the gate buys.
  function feed(bar: Bar, data: string): string {
    const isReport = loadTerminalInput().isTerminalFocusOrMouseReport;
    return bar.isCtrlArmed() && !isReport(data) ? bar.consumeCtrl(data) : data;
  }

  function shellBar() {
    const loaded = loadBar('shell');
    loaded.bar.refreshForActiveSession();
    return loaded;
  }

  it('survives a tap once an app in the pane turns mouse reporting on', () => {
    const { bar } = shellBar();
    // The live case: a shell session keeps the narrow scrollback strip, so mouse
    // DECSETs reach the browser. Measured against a real shell with vim-style
    // tracking on, one tap on the terminal spent the armed modifier silently.
    bar.handleAction('ctrl');
    expect(feed(bar, '\x1b[<0;10;5M')).toBe('\x1b[<0;10;5M');
    expect(feed(bar, '\x1b[<0;10;5m')).toBe('\x1b[<0;10;5m');
    expect(bar.isCtrlArmed()).toBe(true);

    // ...so the character the user actually types is still the one modified.
    expect(feed(bar, 'd')).toBe('\x04');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('survives a focus report, should one ever reach xterm', () => {
    // Defense in depth: FOCUS_ESCAPE_FILTER (session.ts) strips `\x1b[?1004h`
    // from every PTY read, so sendFocusMode never turns on today. If it did,
    // the bar's own post-key refocus would emit `\x1b[I` and eat the modifier
    // before the user typed a single character.
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(feed(bar, '\x1b[I')).toBe('\x1b[I');
    expect(bar.isCtrlArmed()).toBe(true);
    expect(feed(bar, 'c')).toBe('\x03');
  });

  it('still spends the modifier on a paste, which is real input', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(feed(bar, 'git status')).toBe('git status');
    expect(bar.isCtrlArmed()).toBe(false);
  });
});

describe('one-shot Ctrl through the CJK input field', () => {
  // The CJK textarea swallows keystrokes before onData sees them, so the CJK
  // send path needs the modifier applied too. These drive the REAL
  // _handleCjkInput against the REAL bar, both loaded into one vm scope.
  function cjkApp() {
    const { ReverieApp, bar } = loadTerminalModule();
    bar.clearCtrl();
    const app = Object.create(ReverieApp.prototype) as {
      activeSessionId: string;
      _sendInputAsync: ReturnType<typeof vi.fn>;
      _handleCjkInput(text: string): void;
    };
    app.activeSessionId = 'cjk-session';
    app._sendInputAsync = vi.fn();
    return { app, bar };
  }

  it('sends the control byte for a character typed into the CJK field', () => {
    const { app, bar } = cjkApp();
    bar.toggleCtrl();
    app._handleCjkInput('c');
    expect(app._sendInputAsync).toHaveBeenCalledWith('cjk-session', '\x03');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('preserves Ctrl and prediction intent on a known hold until an explicit accepted user retry', () => {
    const {app, bar} = cjkApp();
    const clearPredictions = vi.fn();
    const sessions = new Map([['cjk-session', {id: 'cjk-session', terminalInputHeld: true}]]);
    Object.assign(app, {sessions, _localEchoPolicy: 'predict', _predictiveEcho: {clearPredictions}});
    app._sendInputAsync.mockReturnValue(true); // Local queue acceptance, not provider delivery.
    bar.toggleCtrl();
    expect(app._handleCjkInput('c')).toBe(false);
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(bar.isCtrlArmed()).toBe(true); expect(clearPredictions).not.toHaveBeenCalled();
    // This component fixture changes its denial predicate, then the user retries;
    // no timer, status read or reconciliation grant is inferred here.
    sessions.set('cjk-session', {id: 'cjk-session', terminalInputHeld: false});
    expect(app._handleCjkInput('c')).toBe(true);
    expect(app._sendInputAsync).toHaveBeenCalledExactlyOnceWith('cjk-session', '\x03');
    expect(bar.isCtrlArmed()).toBe(false); expect(clearPredictions).toHaveBeenCalledOnce();
  });

  it('leaves ordinary CJK input untouched when nothing is armed', () => {
    const { app } = cjkApp();
    app._handleCjkInput('你好');
    expect(app._sendInputAsync).toHaveBeenCalledWith('cjk-session', '你好');
  });

  it('spends the modifier on a committed IME word instead of stranding it', () => {
    // The gap this closes: with the field focused the modifier could neither
    // fire nor be spent, so it survived to bite a later innocent keystroke.
    const { app, bar } = cjkApp();
    bar.toggleCtrl();
    app._handleCjkInput('你好');
    expect(app._sendInputAsync).toHaveBeenCalledWith('cjk-session', '你好');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('spends the modifier on Enter, like every other non-character key', () => {
    const { app, bar } = cjkApp();
    bar.toggleCtrl();
    app._handleCjkInput('\r');
    expect(app._sendInputAsync).toHaveBeenCalledWith('cjk-session', '\r');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('drops the input, and does not spend the modifier, with no active session', () => {
    const { app, bar } = cjkApp();
    (app as unknown as { activeSessionId: string | null }).activeSessionId = null;
    bar.toggleCtrl();
    app._handleCjkInput('c');
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(bar.isCtrlArmed()).toBe(true);
  });
});

describe('armed styling survives the light-skin overrides', () => {
  const mobileCss = readFileSync(resolve(publicRoot, 'mobile.css'), 'utf8');

  it('excludes .armed from the light-skin .accessory-btn repaint', () => {
    // That selector is (0,3,1): `:is()` takes the specificity of its most
    // specific argument and the list holds `.btn-toolbar.btn-shell`. It
    // therefore OUTRANKS the (0,3,0) armed rules in both stylesheets, and a
    // bare `.accessory-btn` there paints the armed modifier back to a resting
    // button on all four light skins (measured across every skin at 390px).
    const lightSkinRule = mobileCss
      .split('\n')
      .find((line) => line.includes('[data-skin="paper-gray"]') && line.includes('.btn-voice-mobile,'));

    expect(lightSkinRule).toBeDefined();
    expect(lightSkinRule).toContain('.accessory-btn:not(.armed)');
  });

  it('keeps an armed rule in both stylesheets', () => {
    // mobile.css hardcodes the phone palette, styles.css carries the
    // skin-aware one for everything wider.
    expect(mobileCss).toContain('.accessory-btn.accessory-btn-ctrl.armed');
    expect(readFileSync(resolve(publicRoot, 'styles.css'), 'utf8')).toContain(
      '.accessory-btn.accessory-btn-ctrl.armed'
    );
  });
});

describe('composer nav keys from the bar', () => {
  const sentKeys = (fetchMock: { mock: { calls: unknown[][] } }) =>
    fetchMock.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body).input);

  async function settleNavigation(app: Awaited<ReturnType<typeof barWithDraft>>['app'], count: number) {
    // Queue acceptance is not delivery. Join each real HTTP/journal settlement,
    // then advance only the production cooldown that schedules the next drain.
    // Do not call _drainSession here: that could hide a missing scheduled wake.
    for (let i = 0; i < count; i++) {
      await app._inputDrainTasks.get('session-1');
      await app._inputOutcomes.get('session-1');
      if (i + 1 < count) await vi.advanceTimersByTimeAsync(80);
    }
    const stored = await app._inputJournal.snapshot();
    expect({
      pending: app._pendingDeliveries.get('session-1') || [],
      flights: app._inputFlights.size,
      records: stored.records,
      retained: stored.retained,
      holds: stored.holds,
    }).toEqual({ pending: [], flights: 0, records: [], retained: [], holds: [] });
  }

  it.each(['simple', 'extended'])('exposes Shift arrows in the %s agent layout', (mode) => {
    const { bar, barElement } = loadBar('codex');
    bar.setMode(mode);
    expect(barElement.actions).toContain('shift-left');
    expect(barElement.actions).toContain('shift-right');
  });

  it.each([
    ['shift-left', '\x1b[1;2D'],
    ['shift-right', '\x1b[1;2C'],
  ])('%s flushes the draft before navigation and hands editing to the PTY', async (action, sequence) => {
    const { bar, app, overlay, fetchMock } = await barWithDraft('unfinished follow-up');
    bar.handleAction(action);
    await app._terminalDraftTail;
    await expect.poll(() => sentKeys(fetchMock)).toEqual(['unfinished follow-up', sequence]);
    expect(overlay.pendingText).toBe('');
    expect([...(app._echoPassthroughSessions as Set<string>)]).toEqual(['session-1']);
  });

  it('flushes the unsent draft before sending the arrow', async () => {
    // On a phone the typed text lives in the overlay and has NEVER reached the
    // PTY, so an arrow sent on its own arrives at a composer the CLI still
    // considers empty: Up recalls a history entry into it while the overlay
    // goes on painting the draft over the same row and still believes it is
    // pending. Flushing first is also what makes the draft recoverable: the
    // CLI stashes the live composer and hands it back on Down.
    const { bar, app, overlay, fetchMock } = await barWithDraft('draft I typed');

    bar.handleAction('scroll-up');
    await app._terminalDraftTail;
    await expect.poll(() => sentKeys(fetchMock)).toEqual(['draft I typed', '\x1b[A']);
    expect(overlay.pendingText).toBe('');
    expect(overlay.getFlushed()).toEqual({count: 0, text: ''});
    // The overlay's bookkeeping for this session has to go with it.
    expect((app._flushedOffsets as Map<string, number>).has('session-1')).toBe(false);
    expect((app._flushedTexts as Map<string, string>).has('session-1')).toBe(false);
  });

  it('hands the session to plain PTY echo, like a typed nav key does', async () => {
    // After a nav key the real cursor can sit mid-text, where the overlay's
    // append-only buffering cannot track edits (issue #218). terminal-ui.js's
    // onData branch does exactly this for a nav key typed on a keyboard.
    const { bar, app } = await barWithDraft('');

    bar.handleAction('arrow-left');
    await app._terminalDraftTail;
    expect([...(app._echoPassthroughSessions as Set<string>)]).toEqual(['session-1']);
  });

  it('sends all four arrows and skips the flush when there is no draft', async () => {
    const { bar, app, fetchMock } = await barWithDraft('');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      bar.handleAction('scroll-up');
      bar.handleAction('scroll-down');
      bar.handleAction('arrow-left');
      bar.handleAction('arrow-right');
      await app._terminalDraftTail;
      await settleNavigation(app, 4);
      expect(sentKeys(fetchMock)).toEqual(['\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C']);
      expect(fetchMock.mock.calls.every((call) => JSON.parse(String(call[1]?.body)).input.length === 3)).toBe(true);
      const tags = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
      expect(tags.map((tag) => tag.seq)).toEqual([1, 2, 3, 4]);
      expect(tags.every((tag) => tag.clientId === app._inputJournal.issuer)).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it('does not mistake storage acceptance for four completed navigation deliveries', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bar, app, fetchMock } = await barWithDraft('', async () => {
      started();
      await blocked;
      return Response.json({ success: true, data: {} });
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      for (const action of ['scroll-up', 'scroll-down', 'arrow-left', 'arrow-right']) bar.handleAction(action);
      await app._terminalDraftTail;
      await entered;
      expect(sentKeys(fetchMock)).toEqual(['\x1b[A']);
      const queued = await app._inputJournal.snapshot();
      expect(queued.records.map((record) => [record.seq, record.phase])).toEqual([
        [1, 'may-issued'],
        [2, 'prepared'],
        [3, 'prepared'],
        [4, 'prepared'],
      ]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sentKeys(fetchMock)).toEqual(['\x1b[A']);
      release();
      await settleNavigation(app, 4);
      expect(sentKeys(fetchMock)).toEqual(['\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C']);
      expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).seq)).toEqual([1, 2, 3, 4]);
    } finally {
      release();
      await app._inputDrainTasks.get('session-1');
      await app._inputOutcomes.get('session-1');
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it('an aborted transaction retains the editable draft, offsets and navigation intent without any POST', async () => {
    const {bar, app, overlay, fetchMock, fixture} = await barWithDraft('do not erase this');
    fixture.abortWrites(); bar.handleAction('arrow-left');
    expect(await app._terminalDraftTail).toBe(false);
    expect(overlay.pendingText).toBe('do not erase this'); expect(overlay.clear).not.toHaveBeenCalled();
    expect((app._flushedOffsets as Map<string, number>).get('session-1')).toBe(3);
    expect((app._echoPassthroughSessions as Set<string> | undefined)?.has('session-1')).not.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Codex shift-arrow keys are gated on the active session', () => {
  // ⇧←/⇧→ are Codex bindings. They ship in both agent templates, but a tap in
  // any other CLI would do nothing AND hand the session to PTY echo
  // (sendNavKey adds it to _echoPassthroughSessions), so on a phone a dead key
  // would also switch local echo off for the rest of the prompt. The reveal
  // follows the 🧠 key's shape: a marker class on the BAR element, because
  // setMode() rebuilds the buttons' innerHTML on every layout switch.
  const stylesSource = readFileSync(resolve(publicRoot, 'styles.css'), 'utf8');

  it('marks both shift keys in both agent templates so one CSS rule can hide them', () => {
    const simple = keyboardSource.match(/_simpleButtons\s*:\s*`([\s\S]*?)`/)?.[1] ?? '';
    const extended = keyboardSource.match(/_extendedButtons\s*:\s*`([\s\S]*?)`/)?.[1] ?? '';
    for (const template of [simple, extended]) {
      expect(template).toMatch(/accessory-btn-codex[^>]*data-action="shift-left"/);
      expect(template).toMatch(/accessory-btn-codex[^>]*data-action="shift-right"/);
    }
  });

  it('hides the keys in styles.css until the bar carries codex-enabled', () => {
    expect(stylesSource).toMatch(/\.keyboard-accessory-bar \.accessory-btn-codex \{\s*display: none;/);
    expect(stylesSource).toMatch(
      /\.keyboard-accessory-bar\.codex-enabled \.accessory-btn-codex \{\s*display: inline-flex;/
    );
  });

  it.each(['simple', 'extended'])('carries codex-enabled for a codex session in the %s layout', (mode) => {
    const { bar, barElement } = loadBar('codex');
    bar.setMode(mode);
    expect(barElement.classList.contains('codex-enabled')).toBe(true);
    // The buttons themselves are still in the DOM; the class is what reveals them.
    expect(barElement.actions).toContain('shift-left');
    expect(barElement.actions).toContain('shift-right');
  });

  it.each(['claude', 'shell', 'pi', 'omp', 'deepseek'])(
    'does not carry codex-enabled for a %s session',
    (sessionMode) => {
      const { bar, barElement } = loadBar(sessionMode);
      bar.setMode('extended');
      expect(barElement.classList.contains('codex-enabled')).toBe(false);
    }
  );

  it('re-syncs the class on a session switch, in both directions', () => {
    const { app, bar, barElement } = loadBar('codex');
    expect(barElement.classList.contains('codex-enabled')).toBe(true);

    app.sessions.set('session-2', { mode: 'claude' });
    app.activeSessionId = 'session-2';
    bar.refreshForActiveSession();
    expect(barElement.classList.contains('codex-enabled')).toBe(false);

    app.activeSessionId = 'session-1';
    bar.refreshForActiveSession();
    expect(barElement.classList.contains('codex-enabled')).toBe(true);
  });

  it('drops the class when no session is active (welcome screen)', () => {
    const { app, bar, barElement } = loadBar('codex');
    app.activeSessionId = '';
    bar.refreshForActiveSession();
    expect(barElement.classList.contains('codex-enabled')).toBe(false);
  });

  it('is wired at init and on every session switch, like the 🧠 key', () => {
    const initBody = keyboardSource.match(/\n {2}init\(\) \{([\s\S]*?)\n {2}\},/)?.[1] ?? '';
    const refreshBody = keyboardSource.match(/\n {2}refreshForActiveSession\(\) \{([\s\S]*?)\n {2}\},/)?.[1] ?? '';
    expect(initBody).toContain('this.syncCodexKeys();');
    expect(refreshBody).toContain('this.syncCodexKeys();');
  });
});
