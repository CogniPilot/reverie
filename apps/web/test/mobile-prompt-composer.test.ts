/**
 * @fileoverview CI-visible coverage for the manual mobile prompt composer.
 *
 * The Playwright mobile suite is excluded from the CI gate, so the behaviors
 * most likely to regress live here against the real browser module: native
 * textarea replacement, local-echo adoption, per-session drafts, bracketed
 * multiline delivery and image-path insertion.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZerolagInputAddon } from '../packages/xterm-zerolag-input/src/zerolag-input-addon.js';

const accessorySource = readFileSync(resolve('src/web/public/keyboard-accessory.js'), 'utf8');
const appSource = readFileSync(resolve('src/web/public/app.js'), 'utf8');
const deliverySource = readFileSync(resolve('src/web/public/input-delivery.js'), 'utf8');
const journalSource = readFileSync(resolve('src/web/public/browser-input-journal.js'), 'utf8');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Timer = { callback: () => void; delay: number };

function loadComposer(sessionId = 'session-1') {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="inputRecoveryBar" hidden></div></body></html>', {
    url: 'https://localhost/',
    runScripts: 'outside-only',
  });
  const window = dom.window;
  const timers: Timer[] = [];
  const localEcho = new ZerolagInputAddon();
  vi.spyOn(localEcho, 'clear');
  vi.spyOn(localEcho, 'appendText');
  const actions: Promise<unknown>[] = [];
  let consumedActions = 0;
  const addListener = window.EventTarget.prototype.addEventListener;
  const removeListener = window.EventTarget.prototype.removeEventListener;
  const listeners = new WeakMap<object, EventListener>();
  window.EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    if (!listener) return addListener.call(this, type, listener, options);
    let wrapper = listeners.get(listener);
    if (!wrapper) {
      wrapper = function (this: EventTarget, event) {
        const result: unknown =
          typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
        if (result && typeof result === 'object' && typeof Reflect.get(result, 'then') === 'function')
          actions.push(Promise.resolve(result));
      };
      listeners.set(listener, wrapper);
    }
    return addListener.call(this, type, wrapper, options);
  };
  window.EventTarget.prototype.removeEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ) {
    return removeListener.call(this, type, listener ? listeners.get(listener) || listener : listener, options);
  };
  const settleActions = async () => {
    while (consumedActions < actions.length) {
      const pending = actions.slice(consumedActions);
      consumedActions = actions.length;
      await Promise.all(pending);
    }
  };
  cleanups.push(async () => {
    try {
      await settleActions();
    } finally {
      window.close();
    }
  });
  const InputApp = function () {};
  // Match production script order in this window's own realm; no reservation shim.
  window.eval(journalSource);
  new window.Function('ReverieApp', deliverySource)(InputApp);
  const app = {
    activeSessionId: sessionId,
    sessions: new Map([
      ['session-1', { mode: 'claude' }],
      ['session-2', { mode: 'claude' }],
    ]),
    terminal: { paste: vi.fn(), focus: vi.fn(), modes: { bracketedPasteMode: true } },
    _localEchoEnabled: true,
    _localEchoOverlay: localEcho,
    _tilesOwnTerminal: (): boolean => false,
    _flushedOffsets: new Map<string, number>(),
    _flushedTexts: new Map<string, string>(),
    _echoPassthroughSessions: new Set<string>(),
    _predictiveEcho: { clearPredictions: vi.fn() },
    // Mock only the external acceptance result; editor claims and frame batching are real.
    _sendInputAsync: vi.fn(async (_sid: string, _input: string, _options?: object) => true),
    _uploadAndInsertImages: vi.fn(async () => ['/tmp/image-one.png']),
    _promptAttachKind: (file: { type: string }) =>
      file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : null,
    showToast: vi.fn(),
  };
  Object.setPrototypeOf(app, InputApp.prototype);
  const schedule = (callback: () => void, delay = 0) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  const factory = new Function(
    'window',
    'document',
    'Event',
    'app',
    'MobileDetection',
    'URLSearchParams',
    'fetch',
    'setTimeout',
    'clearTimeout',
    'requestAnimationFrame',
    `${accessorySource}\nreturn KeyboardAccessoryBar;`
  );
  const bar = factory(
    window,
    window.document,
    window.Event,
    app,
    { isTouchDevice: () => true },
    window.URLSearchParams,
    vi.fn(),
    schedule,
    vi.fn(),
    (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }
  );

  return {
    app,
    bar,
    document: window.document,
    localEcho,
    timers,
    settleActions,
    runTimers() {
      for (const timer of timers.splice(0)) timer.callback();
    },
  };
}

function textarea(document: Document): HTMLTextAreaElement {
  return document.querySelector('.prompt-composer-textarea') as HTMLTextAreaElement;
}

function expectFramedAcceptance(
  app: ReturnType<typeof loadComposer>['app'],
  document: Document,
  sid: string,
  paste: string
) {
  const options = app._sendInputAsync.mock.calls[0]?.[2];
  if (!options) throw new Error('The actual frame batch was not submitted');
  const privateKeys = Object.getOwnPropertySymbols(options);
  expect(privateKeys).toHaveLength(1);
  const reservation = Reflect.get(options, privateKeys[0]);
  expect(typeof reservation).toBe('object');
  expect(Object.isFrozen(reservation)).toBe(true);
  // Preserve the exact public arguments and all keys, including the one opaque local handle.
  expect(app._sendInputAsync).toHaveBeenCalledExactlyOnceWith(sid, paste + '\r', {
    frames: [paste, '\r'],
    [privateKeys[0]]: reservation,
  });
  const scope = document.defaultView as unknown as {
    ReverieInputJournal: { intake: { snapshot(): { chars: number; units: number } } };
  };
  expect(scope.ReverieInputJournal.intake.snapshot()).toMatchObject({ chars: 0, units: 0 });
}

function mountComposeButton(bar: any, document: Document): HTMLButtonElement {
  bar.element = document.createElement('div');
  bar.element.innerHTML = bar._simpleButtons;
  document.body.appendChild(bar.element);
  bar._syncComposerDraftIndicator();
  return bar.element.querySelector('[data-action="compose"]') as HTMLButtonElement;
}

describe('mobile prompt composer', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('replaces Paste with Compose on agent bars while shell keeps direct Paste', () => {
    const template = (name: string) => accessorySource.match(new RegExp(name + '\\s*:\\s*`([\\s\\S]*?)`'))?.[1] ?? '';

    expect(template('_simpleButtons')).toContain('data-action="compose"');
    expect(template('_simpleButtons')).not.toContain('data-action="paste"');
    expect(template('_extendedButtons')).toContain('data-action="compose"');
    expect(template('_extendedButtons')).not.toContain('data-action="paste"');
    expect(template('_shellButtons')).toContain('data-action="paste"');
    expect(template('_shellButtons')).not.toContain('data-action="compose"');
  });

  it('uses a compact accessible icon for Compose in both agent layouts', () => {
    const { bar, document } = loadComposer();

    for (const markup of [bar._simpleButtons, bar._extendedButtons]) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = markup;
      const button = wrapper.querySelector('[data-action="compose"]') as HTMLButtonElement;

      expect(button.getAttribute('aria-label')).toBe('Compose prompt');
      expect(button.getAttribute('title')).toBe('Compose prompt');
      expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(button.textContent?.trim()).toBe('');
    }
  });

  it('uses a native autocorrect-aware textarea and stores replacement text exactly once', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    await bar.composePrompt();
    const input = textarea(document);

    expect(input.getAttribute('autocorrect')).toBe('on');
    expect(input.getAttribute('autocapitalize')).toBe('sentences');
    expect(input.getAttribute('spellcheck')).toBe('true');

    input.value = 'Please fix teh bug';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    input.value = 'Please fix the bug';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    (document.querySelector('.paste-cancel') as HTMLButtonElement).click();
    await settleActions();

    await bar.composePrompt();
    expect(textarea(document).value).toBe('Please fix the bug');
    expect(app.terminal.paste).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('adopts and clears locally-buffered terminal input on open', async () => {
    const { app, bar, document, localEcho } = loadComposer();
    localEcho.appendText('-written prompt');
    localEcho.setFlushed(4, 'half');
    app._flushedOffsets.set('session-1', 4);
    app._flushedTexts.set('session-1', 'half');

    await bar.composePrompt();

    expect(textarea(document).value).toBe('half-written prompt');
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x7f'.repeat(4), { useMux: true });
    expect(localEcho.clear).not.toHaveBeenCalled();
    expect(localEcho.pendingText).toBe('');
    expect(localEcho.getFlushed()).toEqual({ count: 0, text: '' });
    expect(app._flushedOffsets.has('session-1')).toBe(false);
    expect(app._flushedTexts.has('session-1')).toBe(false);
  });

  it('uses Unicode code points when erasing flushed text', async () => {
    const { app, bar, document, localEcho } = loadComposer();
    localEcho.setFlushed(3, 'a😀');
    app._flushedOffsets.set('session-1', 3);
    app._flushedTexts.set('session-1', 'a😀');

    await bar.composePrompt();

    expect(textarea(document).value).toBe('a😀');
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x7f'.repeat(2), { useMux: true });
  });

  it('closes on tab switch and keeps drafts isolated by session', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    const composeButton = mountComposeButton(bar, document);
    await bar.composePrompt();
    textarea(document).value = 'first session draft';
    textarea(document).dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    expect(composeButton.classList.contains('has-draft')).toBe(true);

    app.activeSessionId = 'session-2';
    bar.refreshForActiveSession();
    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();
    expect(composeButton.classList.contains('has-draft')).toBe(false);
    expect(() => bar.refreshForActiveSession()).not.toThrow();
    await bar.composePrompt();
    expect(textarea(document).value).toBe('');
    textarea(document).value = 'second session draft';
    textarea(document).dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    (document.querySelector('.paste-cancel') as HTMLButtonElement).click();
    await settleActions();

    app.activeSessionId = 'session-1';
    bar.refreshForActiveSession();
    expect(composeButton.classList.contains('has-draft')).toBe(true);
    expect(composeButton.getAttribute('aria-label')).toBe('Compose prompt, draft saved');
    await bar.composePrompt();
    expect(textarea(document).value).toBe('first session draft');
  });

  it('drops a draft and closes its composer when the session is deleted', async () => {
    const { bar, document } = loadComposer();
    const composeButton = mountComposeButton(bar, document);
    await bar.composePrompt();
    textarea(document).value = 'temporary secret';
    textarea(document).dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    expect(composeButton.classList.contains('has-draft')).toBe(true);

    bar.discardComposerDraft('session-1');

    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();
    expect(composeButton.classList.contains('has-draft')).toBe(false);
    await bar.composePrompt();
    expect(textarea(document).value).toBe('');
  });

  it('refused acceptance keeps the original flushed and editable text in their real editor', async () => {
    const { app, bar, localEcho, document } = loadComposer();
    localEcho.setFlushed(1, 'X');
    localEcho.appendText('A');
    app._sendInputAsync.mockResolvedValueOnce(false);
    await bar.composePrompt();
    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();
    expect(localEcho.pendingText).toBe('A');
    expect(localEcho.getFlushed()).toEqual({ count: 1, text: 'X' });
    expect(app._sendInputAsync).toHaveBeenCalledExactlyOnceWith('session-1', '\x7f', { useMux: true });
    expect(localEcho.clear).not.toHaveBeenCalled();
  });

  it('an edit after accepted erasure preserves the full original transfer without repeating erasure', async () => {
    const { app, bar, localEcho, document } = loadComposer();
    localEcho.setFlushed(1, 'X');
    localEcho.appendText('A');
    let release!: (accepted: boolean) => void, entered!: () => void;
    const began = new Promise<void>((done) => {
      entered = done;
    });
    app._sendInputAsync.mockImplementationOnce(() => {
      entered();
      return new Promise<boolean>((done) => {
        release = done;
      });
    });
    const transfer = bar.composePrompt();
    await began;
    localEcho.appendText('B');
    release(true);
    await transfer;
    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();
    expect(localEcho.pendingText).toBe('AB');
    expect(localEcho.getFlushed()).toEqual({ count: 0, text: '' });
    const recovered = document.querySelector<HTMLTextAreaElement>('[data-local-editor-draft]');
    expect(recovered?.value).toBe('XA');
    expect(recovered?.readOnly).toBe(true);
    await bar.composePrompt();
    expect(textarea(document).value).toBe('AB');
    expect(app._sendInputAsync).toHaveBeenCalledExactlyOnceWith('session-1', '\x7f', { useMux: true });
  });

  it('a refused composed batch retains its draft and cannot emit a later Enter', async () => {
    const { app, bar, document, settleActions, runTimers } = loadComposer();
    await bar.composePrompt();
    textarea(document).value = 'keep this';
    textarea(document).dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    app._sendInputAsync.mockResolvedValueOnce(false);
    (document.querySelector('.paste-send') as HTMLButtonElement).click();
    await settleActions();
    expect(textarea(document).value).toBe('keep this');
    expect(document.querySelector('.prompt-composer-overlay')).not.toBeNull();
    const paste = '\x1b[200~keep this\x1b[201~';
    expectFramedAcceptance(app, document, 'session-1', paste);
    runTimers();
    await settleActions();
    expect(app._sendInputAsync).toHaveBeenCalledOnce();
  });

  it('wires session cleanup to composer draft cleanup', () => {
    const cleanupStart = appSource.indexOf('  _cleanupSessionData(sessionId) {');
    expect(cleanupStart, '_cleanupSessionData not found — renamed?').toBeGreaterThan(-1);
    // The whole method, not a fixed byte window. A 1200-character slice made
    // this assertion depend on how much OTHER code sat above the line it cares
    // about, so an unrelated addition near the top of the method failed it.
    const cleanup = appSource.slice(cleanupStart, appSource.indexOf('\n  }\n', cleanupStart));
    expect(cleanup.length, 'method body did not terminate').toBeGreaterThan(0);

    expect(cleanup).toContain('KeyboardAccessoryBar.discardComposerDraft?.(sessionId)');
  });

  it('keeps Enter as a newline and queues distinct paste and Enter frames in one accepted batch', async () => {
    const { app, bar, document, timers, runTimers, settleActions } = loadComposer();
    const composeButton = mountComposeButton(bar, document);
    await bar.composePrompt();
    const input = textarea(document);
    input.value = 'first line\nsecond line';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    input.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(app.terminal.paste).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    (document.querySelector('.paste-send') as HTMLButtonElement).click();
    await settleActions();

    expect(app.terminal.paste).not.toHaveBeenCalled();
    expect(app._sendInputAsync).toHaveBeenCalledOnce();
    const paste = '\x1b[200~first line\rsecond line\x1b[201~';
    expectFramedAcceptance(app, document, 'session-1', paste);
    expect(composeButton.classList.contains('has-draft')).toBe(false);
    expect(timers.some((timer) => timer.delay === 120)).toBe(false);
    runTimers();
    expect(app._sendInputAsync).toHaveBeenCalledOnce();
    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();

    await bar.composePrompt();
    expect(textarea(document).value).toBe('');
  });

  it('sends after replay resets xterm’s mirrored bracketed-paste mode', async () => {
    const { app, bar, document, runTimers, settleActions } = loadComposer();
    app.terminal.modes.bracketedPasteMode = false;
    await bar.composePrompt();
    textarea(document).value = 'still\nmultiline';
    textarea(document).dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));

    (document.querySelector('.paste-send') as HTMLButtonElement).click();
    await settleActions();

    expect(app.terminal.paste).not.toHaveBeenCalled();
    const paste = '\x1b[200~still\rmultiline\x1b[201~';
    expectFramedAcceptance(app, document, 'session-1', paste);
    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();
    expect(app.showToast).not.toHaveBeenCalled();
    runTimers();
    expect(app._sendInputAsync).toHaveBeenCalledOnce();
  });

  it('releases echo passthrough after a composed prompt is queued', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    app._echoPassthroughSessions.add('session-1');
    app._echoPassthroughSessions.add('session-2');
    await bar.composePrompt();
    textarea(document).value = 'send from composer';

    (document.querySelector('.paste-send') as HTMLButtonElement).click();
    await settleActions();

    expect(app._echoPassthroughSessions.has('session-1')).toBe(false);
    expect(app._echoPassthroughSessions.has('session-2')).toBe(true);
  });

  it('keeps an oversized prompt as a draft instead of queueing a rejected frame', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    await bar.composePrompt();
    const input = textarea(document);
    input.value = 'x'.repeat(65525);
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));

    (document.querySelector('.paste-send') as HTMLButtonElement).click();
    await settleActions();

    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('too long'), 'error');
    expect(document.querySelector('.prompt-composer-overlay')).not.toBeNull();
    expect(bar._composerDrafts.get('session-1')).toHaveLength(65525);
  });

  it('treats a whitespace-only draft as empty instead of submitting blank lines', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    await bar.composePrompt();
    textarea(document).value = ' \n\n ';

    (document.querySelector('.paste-send') as HTMLButtonElement).click();
    await settleActions();

    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(document.querySelector('.prompt-composer-overlay')).not.toBeNull();
  });

  it('derives the prompt budget from the 64 KiB input frame minus both paste markers', async () => {
    // Each frame stays at 64 KiB; the accepted batch also owns its separate Enter.
    const { app, bar, document, settleActions } = loadComposer();
    expect(bar._composerMaxLength).toBe(64 * 1024 - '\x1b[200~\x1b[201~'.length);
    await bar.composePrompt();
    textarea(document).value = 'y'.repeat(bar._composerMaxLength);

    (document.querySelector('.paste-send') as HTMLButtonElement).click();
    await settleActions();

    expect(app._sendInputAsync).toHaveBeenCalledOnce();
    const frames = (app._sendInputAsync.mock.calls[0][2] as { frames: string[] }).frames;
    expect(frames.map((frame) => frame.length)).toEqual([64 * 1024, 1]);
    expect(frames[1]).toBe('\r');
    expect(frames.join('')).toBe(app._sendInputAsync.mock.calls[0][1]);
    expect(app.showToast).not.toHaveBeenCalled();
  });

  it('returns the text to the prompt and focuses xterm when Use terminal keyboard is chosen', async () => {
    const { app, bar, document, localEcho, runTimers, settleActions } = loadComposer();
    const composeButton = mountComposeButton(bar, document);
    await bar.composePrompt();
    textarea(document).value = 'keep this';
    textarea(document).dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    (document.querySelector('.prompt-composer-terminal') as HTMLButtonElement).click();
    await settleActions();

    expect(app.terminal.focus).toHaveBeenCalledOnce();
    // The text is on the prompt now, not parked, so there is no draft to resume.
    expect(localEcho.pendingText).toBe('keep this');
    expect(composeButton.classList.contains('has-draft')).toBe(false);
    runTimers();
    localEcho.appendText('; then continue');
    await bar.composePrompt();
    // Adopted back exactly once: a surviving draft would double the first half.
    expect(textarea(document).value).toBe('keep this; then continue');
  });

  it('uploads images without writing into the PTY and inserts their paths into the draft', async () => {
    const { app, bar, document } = loadComposer();
    let finishUpload!: (paths: string[]) => void;
    app._uploadAndInsertImages.mockImplementation(
      () => new Promise<string[]>((resolveUpload) => (finishUpload = resolveUpload))
    );
    await bar.composePrompt();
    const input = textarea(document);
    input.value = 'review';
    input.selectionStart = input.selectionEnd = input.value.length;
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    const fileInput = document.querySelector('.paste-file-input') as HTMLInputElement;
    const image = new document.defaultView!.File(['image'], 'shot.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [image] });

    fileInput.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
    expect((document.querySelector('.paste-image') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(true);
    finishUpload(['/tmp/image-one.png']);
    await vi.waitFor(() => expect(input.value).toBe('review /tmp/image-one.png'));

    expect(app._uploadAndInsertImages).toHaveBeenCalledWith([image], { insert: false });
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(false);
    expect(app.terminal.paste).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('hands a single-line draft back to the terminal prompt and keeps no draft', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    await bar.composePrompt();
    const input = textarea(document);
    input.value = 'describe this image';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));

    (document.querySelector('.prompt-composer-terminal') as HTMLButtonElement).click();
    await settleActions();

    expect(app._localEchoOverlay.appendText).toHaveBeenCalledWith('describe this image');
    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();
    await bar.composePrompt();
    expect(textarea(document).value).toBe('describe this image');
  });

  it('writes the text to the PTY when the session has no buffer overlay, as codex does', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    // Codex turns the buffer overlay off and echoes write-through instead.
    app._localEchoEnabled = false;
    await bar.composePrompt();
    const input = textarea(document);
    input.value = 'describe this image';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));

    (document.querySelector('.prompt-composer-terminal') as HTMLButtonElement).click();
    await settleActions();

    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', ' describe this image');
    expect(app._predictiveEcho.clearPredictions).toHaveBeenCalled();
  });

  it('writes the handoff to the PTY, not the parked overlay, while the tile grid owns the terminal', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    // The grid parks and hides the main terminal, and a tile's Enter cannot flush
    // its overlay, so the text would strand there (same guard as _attachFromToolbar).
    app._tilesOwnTerminal = () => true;
    await bar.composePrompt();
    const input = textarea(document);
    input.value = 'describe this image';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));

    (document.querySelector('.prompt-composer-terminal') as HTMLButtonElement).click();
    await settleActions();

    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', ' describe this image');
  });

  it('refuses an oversized handoff with the draft intact rather than losing it from both surfaces', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    await bar.composePrompt();
    const input = textarea(document);
    input.value = 'x'.repeat(bar._composerMaxLength + 1);
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));

    (document.querySelector('.prompt-composer-terminal') as HTMLButtonElement).click();
    await settleActions();

    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalled();
    // Still open, still holding the text.
    expect(document.querySelector('.prompt-composer-overlay')).not.toBeNull();
    expect(textarea(document).value.length).toBe(bar._composerMaxLength + 1);
  });

  it('disables the terminal handoff while an upload is in flight', async () => {
    const { app, bar, document } = loadComposer();
    let finishUpload!: (paths: string[]) => void;
    app._uploadAndInsertImages.mockImplementation(
      () => new Promise<string[]>((resolveUpload) => (finishUpload = resolveUpload))
    );
    await bar.composePrompt();
    const fileInput = document.querySelector('.paste-file-input') as HTMLInputElement;
    const image = new document.defaultView!.File(['image'], 'shot.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [image] });
    fileInput.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));

    // Tapping it mid-upload would close the overlay and let the upload rebuild a
    // draft holding only the paths, which the next open would prepend.
    expect((document.querySelector('.prompt-composer-terminal') as HTMLButtonElement).disabled).toBe(true);
    finishUpload(['/tmp/image-one.png']);
    await vi.waitFor(() =>
      expect((document.querySelector('.prompt-composer-terminal') as HTMLButtonElement).disabled).toBe(false)
    );
  });

  it('writes to the PTY when the session is in echo passthrough, where Enter skips the overlay', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    app._echoPassthroughSessions = new Set(['session-1']);
    await bar.composePrompt();
    const input = textarea(document);
    input.value = 'describe this image';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));

    (document.querySelector('.prompt-composer-terminal') as HTMLButtonElement).click();
    await settleActions();

    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', ' describe this image');
  });

  // Forward lock, not a check on this diff: the pre-change handoff also preserved
  // the draft and never appended, so this passes on either side of the change. It
  // exists to pin that multi-line stays parked if the single-line route is widened.
  it('parks a multi-line draft instead of mangling it on the single-line prompt', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    await bar.composePrompt();
    const input = textarea(document);
    input.value = 'first line\nsecond line';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));

    (document.querySelector('.prompt-composer-terminal') as HTMLButtonElement).click();
    await settleActions();

    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
    await bar.composePrompt();
    expect(textarea(document).value).toBe('first line\nsecond line');
  });

  it('separates a parked draft from text put on the prompt before the next open', async () => {
    const { bar, document, localEcho, runTimers, settleActions } = loadComposer();
    await bar.composePrompt();
    const input = textarea(document);
    input.value = 'describe this';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    (document.querySelector('.paste-cancel') as HTMLButtonElement).click();
    await settleActions(); // parks the draft
    runTimers();
    // The toolbar Attach put a path on the now-empty prompt with no leading gap.
    localEcho.appendText('/case/.reverie-uploads/paste-1-a.png ');

    await bar.composePrompt();

    expect(textarea(document).value).toBe('describe this /case/.reverie-uploads/paste-1-a.png ');
  });

  it('finishes an upload into a reopened composer without restoring a deleted session draft', async () => {
    const { app, bar, document, settleActions } = loadComposer();
    let finishUpload!: (paths: string[]) => void;
    app._uploadAndInsertImages.mockImplementation(
      () => new Promise<string[]>((resolveUpload) => (finishUpload = resolveUpload))
    );
    await bar.composePrompt();
    const fileInput = document.querySelector('.paste-file-input') as HTMLInputElement;
    const image = new document.defaultView!.File(['image'], 'shot.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [image] });
    fileInput.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
    (document.querySelector('.paste-cancel') as HTMLButtonElement).click();
    await settleActions();
    await bar.composePrompt();
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(true);

    finishUpload(['/tmp/late-image.png']);
    await vi.waitFor(() => expect(textarea(document).value).toBe('/tmp/late-image.png'));
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(false);

    let finishDeletedUpload!: (paths: string[]) => void;
    app._uploadAndInsertImages.mockImplementation(
      () => new Promise<string[]>((resolveUpload) => (finishDeletedUpload = resolveUpload))
    );
    const reopenedInput = document.querySelector('.paste-file-input') as HTMLInputElement;
    Object.defineProperty(reopenedInput, 'files', { configurable: true, value: [image] });
    reopenedInput.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
    app.sessions.delete('session-1');
    bar.discardComposerDraft('session-1');
    finishDeletedUpload(['/tmp/deleted-session.png']);
    await Promise.resolve();
    await Promise.resolve();

    expect(bar._composerDrafts.has('session-1')).toBe(false);
  });

  it('keeps Send disabled until every concurrent image upload finishes', async () => {
    const { app, bar, document } = loadComposer();
    const finishUploads: Array<(paths: string[]) => void> = [];
    app._uploadAndInsertImages.mockImplementation(
      () => new Promise<string[]>((resolveUpload) => finishUploads.push(resolveUpload))
    );
    await bar.composePrompt();
    const input = textarea(document);
    const image = new document.defaultView!.File(['image'], 'shot.png', { type: 'image/png' });
    const pasteImage = () => {
      const item = { type: 'image/png', getAsFile: () => image };
      const event = new document.defaultView!.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { items: [item] } });
      input.dispatchEvent(event);
    };

    pasteImage();
    pasteImage();
    expect(finishUploads).toHaveLength(2);
    finishUploads[0](['/tmp/first.png']);
    await vi.waitFor(() => expect(input.value).toBe('/tmp/first.png'));
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(true);

    finishUploads[1](['/tmp/second.png']);
    await vi.waitFor(() => expect(input.value).toBe('/tmp/first.png /tmp/second.png'));
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers videos in the Image key picker and filters the pick through the shared classifier', async () => {
    const { app, bar, document } = loadComposer();
    await bar.composePrompt();
    const fileInput = document.querySelector('.paste-file-input') as HTMLInputElement;
    expect(fileInput.getAttribute('accept')).toBe('image/*,video/*');
    const video = new document.defaultView!.File(['clip'], 'clip.mov', { type: 'video/quicktime' });
    const pdf = new document.defaultView!.File(['%PDF'], 'notes.pdf', { type: 'application/pdf' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [video, pdf] });

    fileInput.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
    expect(app._uploadAndInsertImages).toHaveBeenCalledWith([video], { insert: false });
    await vi.waitFor(() => expect(textarea(document).value).toContain('/tmp/image-one.png'));
  });

  it('takes a video pasted into the editor through the shared classifier', async () => {
    const { app, bar, document } = loadComposer();
    await bar.composePrompt();
    const input = textarea(document);
    const video = new document.defaultView!.File(['clip'], 'clip.mp4', { type: 'video/mp4' });
    const event = new document.defaultView!.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [
          { type: 'text/plain', getAsFile: () => null },
          { type: 'video/mp4', getAsFile: () => video },
        ],
      },
    });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(app._uploadAndInsertImages).toHaveBeenCalledWith([video], { insert: false });
  });
});

// The shell bar's Paste button (and Compose, which redirects here for a shell
// session) must deliver a multi-line block the way a real terminal paste does:
// one bracketed write, so the shell takes the block as one edit instead of
// running every line the moment its newline arrives, and no Enter, so the
// user reviews the block at the prompt before running it.
describe('mobile shell Paste', () => {
  beforeEach(() => vi.restoreAllMocks());

  function openShellPaste() {
    const harness = loadComposer();
    harness.app.sessions.set('session-1', { mode: 'shell' });
    harness.bar.composePrompt();
    const input = harness.document.querySelector('.paste-textarea') as HTMLTextAreaElement;
    const send = harness.document.querySelector('.paste-overlay .paste-send') as HTMLButtonElement;
    return { ...harness, input, send };
  }

  it('sends a multi-line block once, bracketed, and never presses Enter', async () => {
    const { app, document, input, send, runTimers, settleActions } = openShellPaste();
    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();
    input.value = 'cd ~/dotfiles\ngit pull\n./sync.sh';

    send.click();
    await settleActions();
    runTimers();

    expect(app._sendInputAsync).toHaveBeenCalledOnce();
    expect(app._sendInputAsync).toHaveBeenCalledWith(
      'session-1',
      '\x1b[200~cd ~/dotfiles\rgit pull\r./sync.sh\x1b[201~'
    );
    expect(document.querySelector('.paste-overlay')).toBeNull();
  });

  it('normalizes CRLF line endings to the CR a terminal paste carries', async () => {
    const { app, input, send, settleActions } = openShellPaste();
    input.value = 'echo one\r\necho two';

    send.click();
    await settleActions();

    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x1b[200~echo one\recho two\x1b[201~');
  });

  it('drops paste markers inside the text, so a pasted ESC[201~ cannot end the bracket early', async () => {
    const { app, input, send, settleActions } = openShellPaste();
    // A pastejacking page can put the end marker on the clipboard: everything
    // after it would be typed as keys, and its CR would run a command.
    input.value = 'echo safe\x1b[201~\nrm -rf ~/x\x1b[200~';

    send.click();
    await settleActions();

    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x1b[200~echo safe\rrm -rf ~/x\x1b[201~');
  });

  it('refuses a paste longer than one input frame and keeps the text for trimming', async () => {
    const { app, bar, document, input, send, settleActions } = openShellPaste();
    input.value = 'x'.repeat(bar._composerMaxLength + 1);

    send.click();
    await settleActions();

    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('too long'), 'error');
    expect(document.querySelector('.paste-overlay')).not.toBeNull();
    expect(input.value.length).toBe(bar._composerMaxLength + 1);
  });

  it('delivers to the shell it was opened for after a tab switch', async () => {
    const { app, input, send, settleActions } = openShellPaste();
    input.value = 'ls\npwd';
    app.activeSessionId = 'session-2';

    send.click();
    await settleActions();

    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x1b[200~ls\rpwd\x1b[201~');
  });

  it('uploads a picked image to the shell it was opened for after a tab switch', () => {
    const { app, document } = openShellPaste();
    app.activeSessionId = 'session-2';
    const fileInput = document.querySelector('.paste-overlay .paste-file-input') as HTMLInputElement;
    const image = new document.defaultView!.File(['image'], 'shot.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [image] });

    fileInput.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));

    expect(app._uploadAndInsertImages).toHaveBeenCalledWith([image], { sessionId: 'session-1' });
    expect(document.querySelector('.paste-overlay')).toBeNull();
  });

  it('sends nothing for an empty paste', async () => {
    const { app, document, send, runTimers, settleActions } = openShellPaste();

    send.click();
    await settleActions();
    runTimers();

    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(document.querySelector('.paste-overlay')).toBeNull();
  });
});
