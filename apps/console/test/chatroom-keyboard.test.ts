/**
 * Chat panel vs the on-screen keyboard: Android shrinks only the visual viewport,
 * so the panel computes how much of the layout viewport the keyboard covers.
 */
import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// chatroom-ui.js starts the conversation shell loader as it loads, which needs a document: run it in a jsdom window.
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const context = dom.getInternalVMContext();
// The loader revalidates the shell assets with fetch; a fetch that never answers keeps the test off the network.
vm.runInContext('globalThis.ReverieApp = class {}; globalThis.fetch = () => new Promise(() => {});', context);
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/chatroom-ui.js'), 'utf8'), context);
const inset = vm.runInContext('chatKeyboardInset', context) as (h: number, vv: unknown) => number;

afterAll(() => dom.window.close());

describe('chatKeyboardInset', () => {
  it('is the part of the layout viewport the keyboard covers', () => {
    expect(inset(915, { height: 615, offsetTop: 0 })).toBe(300);
  });
  it('accounts for a visual viewport scrolled down inside the layout viewport', () => {
    expect(inset(915, { height: 615, offsetTop: 40 })).toBe(260);
  });
  it('is zero with no keyboard, no visualViewport, or a nonsense reading', () => {
    expect(inset(915, { height: 915, offsetTop: 0 })).toBe(0);
    expect(inset(915, undefined)).toBe(0);
    expect(inset(915, { height: NaN })).toBe(0);
    expect(inset(915, { height: 1000, offsetTop: 0 })).toBe(0);
  });
});
