/** Actual capture handler: browser hard reload is not a chat action. */
import { beforeEach, expect, it, vi } from 'vitest';
import { documentAddEventListener, makeGridApp, resetGridHarness } from './mocks/tile-grid-vm.js';

beforeEach(() => resetGridHarness());

it.each([
  ['chat composer', 'chat', false, false],
  ['chat even with a terminal-like target', 'chat', true, false],
  ['page outside a terminal', 'debug', false, false],
  ['focused debug terminal', 'debug', true, true],
])('Ctrl+Shift+R in %s has the right owner', (_name, view, terminal, expected) => {
  const app = makeGridApp(['s-a']);
  app.$ = () => null;
  app.setupColorPicker = vi.fn();
  app._chatApp = { view };
  app.restoreTerminalSize = vi.fn();
  const before = documentAddEventListener.mock.calls.length;
  app.setupEventListeners();
  const listener = documentAddEventListener.mock.calls.slice(before).find(([type, , capture]) => type === 'keydown' && capture === true)?.[1];
  expect(listener).toBeTypeOf('function');
  const event = {
    key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
    preventDefault: vi.fn(),
    target: { closest: (selector: string) => selector === '.xterm' && terminal ? {} : null },
  };
  listener!(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(expected ? 1 : 0);
  expect(app.restoreTerminalSize).toHaveBeenCalledTimes(expected ? 1 : 0);
});
