/**
 * @fileoverview Fast VM/static regressions for the shared filesystem picker and
 * extended mobile keyboard actions. No browser or real server required.
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZerolagInputAddon } from '../packages/xterm-zerolag-input/src/zerolag-input-addon.js';
import { browserInputFixture } from './helpers/browser-input-fixture.js';

const keyboardSource = readFileSync(resolve('src/web/public/keyboard-accessory.js'), 'utf8');
const terminalSource = readFileSync(resolve('src/web/public/terminal-ui.js'), 'utf8');
const sessionSource = readFileSync(resolve('src/web/public/session-ui.js'), 'utf8');
const indexSource = readFileSync(resolve('src/web/public/index.html'), 'utf8');

function loadTerminalMixin() {
  const FakeReverieApp = function () {} as unknown as { prototype: Record<string, (...args: unknown[]) => unknown> };
  const cjkClear = vi.fn();
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    ReverieApp: FakeReverieApp,
    CjkInput: { clear: cjkClear },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    document: { addEventListener: vi.fn() },
  });
  vm.runInContext(terminalSource, context, { filename: 'terminal-ui.js' });
  return { mixin: FakeReverieApp.prototype, cjkClear };
}

const terminalHarness = loadTerminalMixin();

function loadKeyboardModule() {
  const app = {
    activeSessionId: 'session-1',
    sessions: new Map([['session-1', { workingDir: '/mnt/d/AI' }]]),
    terminal: { focus: vi.fn() },
    clearTerminalInput: vi.fn(),
    insertTerminalText: vi.fn(),
    sendInput: vi.fn(),
  };
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
  const context = vm.createContext({
    app,
    MobileDetection: { isTouchDevice: () => false },
    URLSearchParams,
    fetch: fetchMock,
    document: {},
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: vi.fn(),
  });
  vm.runInContext(
    `${keyboardSource}\nglobalThis.__bar = KeyboardAccessoryBar; globalThis.__picker = PathPicker;`,
    context
  );
  return {
    app,
    fetchMock,
    bar: (context as unknown as { __bar: { handleAction(action: string): void } }).__bar,
    picker: (context as unknown as { __picker: { open: ReturnType<typeof vi.fn> } }).__picker,
  };
}

const journalFixtures: ReturnType<typeof browserInputFixture>[] = [];
afterEach(async () => {
  for (const fixture of journalFixtures.splice(0)) await fixture.close();
});

async function journalKeyboard() {
  const fixture = browserInputFixture();
  journalFixtures.push(fixture);
  const writes: {sid: string; input: string; seq: number}[] = [];
  const base = await fixture.page(async (url, options) => {
    const body = JSON.parse(String(options?.body));
    writes.push({sid: url.split('/')[3], input: body.input, seq: body.seq});
    return Response.json({success: true, data: {}});
  }, ['keyboard-accessory.js', 'terminal-ui.js']);
  const app = Object.assign(base, {
    activeSessionId: 'session-1',
    sessions: new Map([['session-1', {workingDir: '/mnt/d/AI', mode: 'claude'}]]),
    terminal: {focus: vi.fn()},
    _localEchoEnabled: false,
    _localEchoOverlay: null as ZerolagInputAddon | null,
    _inputFlushTimeout: null,
    _pendingInput: '',
    _flushedOffsets: new Map<string, number>(),
    _flushedTexts: new Map<string, string>(),
    clearTerminalInput: terminalHarness.mixin.clearTerminalInput,
  });
  const raw = app._createRawInputBuffer('session-1', owner => {app._pendingInput = owner.data;});
  Object.assign(app, {_pendingInputOwner: raw});
  const bar = fixture.keyboard(app) as {handleAction(action: string): void};
  return {app, bar, raw, writes};
}

async function settleInput(app: Awaited<ReturnType<typeof journalKeyboard>>['app'], sid: string) {
  await app._drainSession(sid);
  await app._inputOutcomes.get(sid);
  expect(app._inputFlights.has(sid)).toBe(false);
  expect(app._pendingDeliveries.get(sid) || []).toEqual([]);
  const snapshot = await app._inputJournal.snapshot();
  expect(snapshot.records.filter(row => row.sid === sid)).toEqual([]);
  expect(snapshot.holds).toEqual([]);
}

describe('accessory Tab key', () => {
  it('replaced /clear in the simple bar; /clear stays extended-only', () => {
    const simple = keyboardSource.slice(
      keyboardSource.indexOf('_simpleButtons'),
      keyboardSource.indexOf('_extendedButtons')
    );
    expect(simple).toContain('data-action="tab"');
    expect(simple).not.toContain('data-action="clear" title="/clear"');
    expect(simple).not.toContain('data-action="compact"');
  });

  it('sends a bare \\t when nothing is buffered locally', async () => {
    const { app, bar, writes } = await journalKeyboard();
    bar.handleAction('tab');
    await expect.poll(() => writes.map(row => row.input)).toEqual(['\t']);
    expect(writes[0].sid).toBe('session-1');
    await settleInput(app, 'session-1');
    expect((await app._inputJournal.snapshot()).records).toEqual([]);
    expect((await app._inputJournal.snapshot()).holds).toEqual([]);
    app._redeliverSweep();
    await settleInput(app, 'session-1');
    expect(writes).toHaveLength(1);
  });

  it('flushes locally-buffered prompt text to the PTY before sending Tab', async () => {
    const { app, bar, writes } = await journalKeyboard();
    const overlay = new ZerolagInputAddon();
    overlay.appendText('git sta');
    overlay.setFlushed(3, 'git');
    Object.assign(app, {
      _localEchoEnabled: true,
      _localEchoOverlay: overlay,
      _flushedOffsets: new Map([['session-1', 3]]),
      _flushedTexts: new Map([['session-1', 'git']]),
    });

    bar.handleAction('tab');
    await expect.poll(() => writes.map(row => row.input)).toEqual(['git sta', '\t']);
    expect(writes.map(row => row.sid)).toEqual(['session-1', 'session-1']);
    expect(writes[1].seq).toBe(writes[0].seq + 1);
    expect(overlay.pendingText).toBe('');
    expect(overlay.getFlushed()).toEqual({count: 0, text: ''});
    expect(app._flushedOffsets.has('session-1')).toBe(false);
    expect(app._flushedTexts.has('session-1')).toBe(false);
    await settleInput(app, 'session-1');
    app._redeliverSweep();
    await settleInput(app, 'session-1');
    expect(writes).toHaveLength(2);
  });
});

describe('mobile filesystem picker actions', () => {
  it('keeps clear-input separate from the destructive /clear command', () => {
    const { app, bar } = loadKeyboardModule();
    bar.handleAction('clear-input');

    expect(app.clearTerminalInput).toHaveBeenCalledOnce();
    expect(app.sendInput).not.toHaveBeenCalled();
    expect(keyboardSource).toContain('data-action="clear-input"');
    expect(keyboardSource).toContain('data-action="clear" title="/clear"');
  });

  it('opens at the active working directory and inserts the selected path without Enter', () => {
    const { app, bar, picker } = loadKeyboardModule();
    picker.open = vi.fn();

    bar.handleAction('pick-path');

    expect(picker.open).toHaveBeenCalledOnce();
    const options = picker.open.mock.calls[0][0];
    expect(options).toMatchObject({
      sessionId: 'session-1',
      initialPath: '/mnt/d/AI',
      directoriesOnly: false,
    });
    options.onSelect('/mnt/d/AI/project/file.ts');
    expect(app.insertTerminalText).toHaveBeenCalledWith('/mnt/d/AI/project/file.ts');
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it('wires Link Existing to the shared folder-only picker', () => {
    expect(indexSource).toContain('onclick="app.openLinkCasePathPicker()"');
    expect(indexSource).toContain('id="linkCasePath"');
    expect(sessionSource).toContain('openLinkCasePathPicker()');
    expect(sessionSource).toContain('directoriesOnly: true');
  });

  it('keeps Choose separate from safe inline file preview', () => {
    expect(keyboardSource).toContain('openPreview(entry)');
    expect(keyboardSource).toContain('/api/filesystem/preview?');
    expect(keyboardSource).toContain("entry.previewKind === 'image'");
    expect(keyboardSource).toContain("entry.previewKind === 'text'");
    expect(keyboardSource).toContain("choose.textContent = 'Choose'");
    expect(keyboardSource).toContain('pre.textContent = content');
  });

  it('inserts a selected path into the editable local-echo prompt without sending it', () => {
    const appendText = vi.fn();
    const sendInput = vi.fn();
    const focus = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      _localEchoEnabled: true,
      _localEchoOverlay: { appendText },
      terminal: { focus },
      sendInput,
    };

    terminalHarness.mixin.insertTerminalText.call(app, '/mnt/d/AI/project');

    expect(appendText).toHaveBeenCalledWith('/mnt/d/AI/project');
    expect(sendInput).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('clears pending and already-flushed prompt text without invoking /clear', async () => {
    const {app, raw, writes} = await journalKeyboard();
    const overlay = new ZerolagInputAddon();
    overlay.appendText('local only'); overlay.setFlushed(4, 'a😀b');
    raw.append('pending text');
    Object.assign(app, {_localEchoEnabled: true, _localEchoOverlay: overlay,
      _flushedOffsets: new Map([['session-1', 4]]), _flushedTexts: new Map([['session-1', 'a😀b']])});
    terminalHarness.cjkClear.mockClear();
    expect(await app.clearTerminalInput()).toBe(true);
    expect(app._pendingInput).toBe(''); expect(raw.data).toBe('');
    expect(overlay.pendingText).toBe(''); expect(overlay.getFlushed()).toEqual({count: 0, text: ''});
    await expect.poll(() => writes.map(row => row.input)).toEqual(['pending text', '\x7f'.repeat(3)]);
    expect(writes.every(row => row.sid === 'session-1')).toBe(true);
    expect(writes.map(row => row.input)).not.toContain('/clear');
    expect(app._flushedOffsets.size).toBe(0); expect(app._flushedTexts.size).toBe(0);
    expect(app.showToast).toHaveBeenCalledWith('Clear input queued', 'success');
    expect(app.terminal.focus).toHaveBeenCalledOnce(); expect(terminalHarness.cjkClear).toHaveBeenCalled();
    await settleInput(app, 'session-1');
    app._redeliverSweep(); await settleInput(app, 'session-1'); expect(writes).toHaveLength(2);
  });

  it('sends a picked path to the tile or Pane B that holds the keyboard, never the parked main overlay', () => {
    const appendText = vi.fn();
    const sendInput = vi.fn();
    const _sendInputAsync = vi.fn();
    const mainFocus = vi.fn();
    const tileFocus = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      _localEchoEnabled: true,
      _localEchoOverlay: { appendText },
      terminal: { focus: mainFocus },
      sendInput,
      _sendInputAsync,
      _focusedPane: () => ({ terminal: { focus: tileFocus }, sessionId: 'tile-2', isPrimary: false, tile: {} }),
    };

    terminalHarness.mixin.insertTerminalText.call(app, '/mnt/d/AI/project');

    expect(_sendInputAsync).toHaveBeenCalledWith('tile-2', '/mnt/d/AI/project');
    expect(appendText).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
    expect(tileFocus).toHaveBeenCalledOnce();
    expect(mainFocus).not.toHaveBeenCalled();
  });

  it('clears the prompt of the tile or Pane B that holds the keyboard with Ctrl+U, leaving the main overlay alone', async () => {
    const {app, raw, writes} = await journalKeyboard();
    const overlay = new ZerolagInputAddon(); overlay.appendText('parked local draft');
    raw.append('main pane text');
    const tileFocus = vi.fn();
    Object.assign(app, {_localEchoEnabled: true, _localEchoOverlay: overlay,
      _focusedPane: () => ({terminal: {focus: tileFocus}, sessionId: 'tile-2', isPrimary: false, tile: {}})});
    await app.clearTerminalInput();
    await expect.poll(() => writes.map(row => [row.sid, row.input])).toEqual([['tile-2', '\x15']]);
    expect(overlay.pendingText).toBe('parked local draft');
    expect(raw.data).toBe('main pane text'); expect(app._pendingInput).toBe('main pane text');
    expect(app.showToast).toHaveBeenCalledWith('Clear input queued', 'success');
    expect(tileFocus).toHaveBeenCalledOnce(); expect(app.terminal.focus).not.toHaveBeenCalled();
    await settleInput(app, 'tile-2');
    app._redeliverSweep(); await settleInput(app, 'tile-2'); expect(writes).toHaveLength(1);
  });

  it('uses Ctrl+U to clear the TUI-owned prompt when local echo is disabled', async () => {
    const {app, writes} = await journalKeyboard();
    expect(await app.clearTerminalInput()).toBe(true);
    await expect.poll(() => writes.map(row => [row.sid, row.input])).toEqual([['session-1', '\x15']]);
    await settleInput(app, 'session-1');
    app._redeliverSweep(); await settleInput(app, 'session-1'); expect(writes).toHaveLength(1);
  });
});
