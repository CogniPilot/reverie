/**
 * "Message <agent>" box under an agent terminal: opens the DM, posts the text as a chat message, clears the box,
 * sends only once at a time, and keeps the text when the server refuses.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const ui = readFileSync(resolve('src/web/public/session-ui.js'), 'utf8');

// Exercise the real form renderer in an owned DOM, with no server or provider.
const jsdom: unknown = createRequire(import.meta.url)('jsdom');
if (!jsdom || typeof jsdom !== 'object') throw new Error('JSDOM module unavailable');
const Dom: unknown = Reflect.get(jsdom, 'JSDOM');
type DOM = { window: { document: Document; close(): void } };
function visibilityFixture(catalog?: Array<{ id: string; kind?: string }>) {
  if (typeof Dom !== 'function') throw new Error('JSDOM constructor unavailable');
  const value: unknown = Reflect.construct(Dom, ['<div class="terminal-wrap"></div>']);
  if (!value || typeof value !== 'object') throw new Error('Owned DOM unavailable');
  const dom = value as DOM;
  if (!dom.window?.document || typeof dom.window.close !== 'function') throw new Error('Owned document unavailable');
  const app = {
    activeSessionId: 'fixture',
    sessions: new Map([['fixture', { id: 'fixture', mode: 'fixture', name: 'Synthetic agent' }]]),
  };
  const Constructor = function ReverieApp() {};
  const context = vm.createContext({
    ReverieApp: Constructor,
    document: dom.window.document,
    window: { __reverieCliCatalog: catalog },
  });
  vm.runInContext(ui, context);
  const sync: unknown = Reflect.get(Constructor.prototype, 'syncMessageAgentBar');
  if (typeof sync !== 'function') throw new Error('Message renderer unavailable');
  return { dom, app, sync: () => Reflect.apply(sync, app, []) };
}

describe('syncMessageAgentBar registry classification', () => {
  it.each(['claude', 'custom-agent'])('shows the form for catalogued agent %s', (mode) => {
    const fixture = visibilityFixture([{ id: mode, kind: 'agent' }]);
    try {
      fixture.app.sessions.set('fixture', { id: 'fixture', mode, name: 'Synthetic agent' });
      fixture.sync();
      const bar = fixture.dom.window.document.querySelector<HTMLFormElement>('.message-agent-bar');
      expect(bar?.hidden).toBe(false);
      expect(bar?.querySelector('input')?.getAttribute('aria-label')).toBe('Message Synthetic agent');
    } finally {
      fixture.dom.window.close();
    }
  });

  it.each(['shell', 'custom-shell'])('hides the form for catalogued shell %s', (mode) => {
    const fixture = visibilityFixture([{ id: mode, kind: 'shell' }]);
    try {
      fixture.app.sessions.set('fixture', { id: 'fixture', mode, name: 'Synthetic shell' });
      fixture.sync();
      expect(fixture.dom.window.document.querySelector('.message-agent-bar')).toBeNull();
    } finally {
      fixture.dom.window.close();
    }
  });

  it.each([undefined, [], [{ id: 'fixture' }], [{ id: 'different', kind: 'agent' }]])(
    'keeps absent or unclassified catalog state from offering agent messaging (%j)',
    (catalog) => {
      const fixture = visibilityFixture(catalog);
      try {
        fixture.sync();
        expect(fixture.dom.window.document.querySelector('.message-agent-bar')).toBeNull();
      } finally {
        fixture.dom.window.close();
      }
    }
  );

  it('hides a previously visible form after switching to a shell or removing the active session', () => {
    const fixture = visibilityFixture([
      { id: 'fixture', kind: 'agent' },
      { id: 'console', kind: 'shell' },
    ]);
    try {
      fixture.sync();
      const bar = fixture.dom.window.document.querySelector<HTMLFormElement>('.message-agent-bar');
      expect(bar?.hidden).toBe(false);
      fixture.app.sessions.set('fixture', { id: 'fixture', mode: 'console', name: 'Synthetic shell' });
      fixture.sync();
      expect(bar?.hidden).toBe(true);
      fixture.app.sessions.delete('fixture');
      fixture.sync();
      expect(bar?.hidden).toBe(true);
    } finally {
      fixture.dom.window.close();
    }
  });
});

function load() {
  const body = ui
    .replace(/^[\s\S]*?(?=\n  async _sendMessageToAgent\()/, 'return {')
    .replace(/\n  \/\*\* Footer chip[\s\S]*$/, '\n}');
  return vm.runInContext(`(function(){${body}})()`, vm.createContext({})) as Record<
    string,
    (...a: unknown[]) => Promise<void>
  >;
}

function bar(text: string) {
  const input = { value: text };
  return { input, el: { dataset: { sessionId: 's1' } as Record<string, string>, querySelector: () => input } };
}

describe('_sendMessageToAgent', () => {
  it('opens the DM, posts the text, and clears the box', async () => {
    const calls: Array<[string, unknown]> = [];
    const self = Object.assign(load(), {
      _chatApi: async (url: string, o: { body: unknown }) => (
        calls.push([url, o.body]),
        url.endsWith('/dms') ? { ok: true, data: { id: 'room 1' } } : { ok: true, data: {} }
      ),
      showToast() {},
    });
    const { input, el } = bar('  hello Worker ');
    await self._sendMessageToAgent(el);
    expect(calls).toEqual([
      ['/api/chatrooms/dms', { sessionId: 's1' }],
      ['/api/chatrooms/room%201/messages', { text: 'hello Worker' }],
    ]);
    expect(input.value).toBe('');
  });

  it('keeps the text on a refusal and sends once while one is in flight', async () => {
    let posts = 0;
    let release!: () => void;
    const self = Object.assign(load(), {
      _chatApi: (url: string) => {
        if (url.endsWith('/dms')) return new Promise((r) => (release = () => r({ ok: true, data: { id: 'r' } })));
        posts++;
        return Promise.resolve({ ok: false, error: 'nope' });
      },
      showToast() {},
    });
    const { input, el } = bar('hi');
    const a = self._sendMessageToAgent(el);
    const b = self._sendMessageToAgent(el);
    release();
    await Promise.all([a, b]);
    expect(posts).toBe(1);
    expect(input.value).toBe('hi');
  });
});
