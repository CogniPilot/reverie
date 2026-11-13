/** Existing GUI callers through the actual journal/mixin; no providers or live server. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { browserInputFixture, type InputApp } from './helpers/browser-input-fixture.js';

const fixtures: ReturnType<typeof browserInputFixture>[] = [],
  timers: ReturnType<typeof setTimeout>[] = [];
afterEach(async () => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
type State = { sessionId: string; selected: number; sending?: boolean };
type App = InputApp & {
  activeSessionId: string;
  _rmm: State | null;
  _stopConfirmTimer?: ReturnType<typeof setTimeout>;
  stopClaude(): Promise<boolean>;
  sendReadMyMind(enter: boolean): Promise<boolean>;
};
async function caller() {
  const fixture = browserInputFixture();
  fixtures.push(fixture);
  const posts: { url: string; input: string; seq: number; clientId: string; useMux?: boolean }[] = [];
  const app = (await fixture.page(async (url, options) => {
    expect(new Headers(options?.headers).get('X-Reverie-Input-Protocol')).toBe('2');
    posts.push({ url, ...JSON.parse(String(options?.body)) });
    return Response.json({ success: true, data: {} });
  })) as App;
  const button = {
    innerHTML: 'Stop',
    textContent: 'Stop',
    dataset: {} as Record<string, string>,
    classList: { add() {}, remove() {} },
  };
  const input = Object.assign(new EventTarget(), { value: 'original suggestion' });
  let open = true;
  const document = {
    querySelector: () => button,
    getElementById: (id: string) =>
      id === 'readMyMindPrompt'
        ? input
        : id === 'readMyMindModal'
          ? {
              classList: {
                remove: () => {
                  open = false;
                },
              },
            }
          : null,
  };
  const source = ['session-ui.js', 'readmymind-ui.js']
    .map((name) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8'))
    .join('\n');
  new Function('ReverieApp', 'document', 'window', source)({ prototype: Object.getPrototypeOf(app) }, document, {});
  Object.assign(app, { activeSessionId: 'session-a', _rmm: { sessionId: 'session-a', selected: 0 } });
  const stop = async () => {
    const result = await app.stopClaude();
    if (app._stopConfirmTimer) timers.push(app._stopConfirmTimer);
    return result;
  };
  return { fixture, app, posts, input, stop, isOpen: () => open };
}

it('Stop requires two confirmations for the same original SID and queues exactly one raw interrupt', async () => {
  const { app, posts, stop } = await caller();
  expect(await stop()).toBe(false);
  expect(posts).toEqual([]);
  expect(await stop()).toBe(true);
  await app._drainSession('session-a');
  expect(posts).toEqual([
    { url: '/api/sessions/session-a/input', input: '\x03', seq: 1, clientId: app._inputJournal.issuer, useMux: false },
  ]);
});
it('switching the selected SID cannot spend another session Stop confirmation', async () => {
  const { app, posts, stop } = await caller();
  await stop();
  app.activeSessionId = 'session-b';
  expect(await stop()).toBe(false);
  expect(posts).toEqual([]);
  expect(app.showToast.mock.calls.flat().join(' ')).toMatch(/Session changed/);
  await stop();
  expect(await stop()).toBe(true);
  await app._drainSession('session-b');
  expect(posts).toHaveLength(1);
  expect(posts[0].url).toBe('/api/sessions/session-b/input');
});
it('a Stop storage refusal is visible and causes no input effect', async () => {
  const { fixture, app, posts, stop } = await caller();
  await stop();
  fixture.abortWrites();
  expect(await stop()).toBe(false);
  expect(posts).toEqual([]);
  expect(app.showToast.mock.calls.flat().join(' ')).toMatch(/not queued/);
});
it.each([false, true])(
  'Read My Mind fixes its original SID/text and reports storage acceptance, Enter=%s',
  async (enter) => {
    const { app, input, posts, isOpen } = await caller();
    input.value = ' edited\n suggestion ';
    const sending = app.sendReadMyMind(enter);
    app.activeSessionId = 'session-b';
    expect(await sending).toBe(true);
    await app._drainSession('session-a');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      url: '/api/sessions/session-a/input',
      input: enter ? 'edited  suggestion\r' : 'edited  suggestion',
    });
    expect(isOpen()).toBe(false);
    expect(app.showToast.mock.calls.flat().join(' ')).toMatch(/queued/);
    expect(app.showToast.mock.calls.flat().join(' ')).not.toMatch(/Prompt sent/);
  }
);
it('100 explicit editable retries after storage refusal preserve the draft without orphan copies or effects', async () => {
  const { fixture, app, input, posts, isOpen } = await caller();
  fixture.abortWrites();
  for (let count = 0; count < 100; count++) expect(await app.sendReadMyMind(true)).toBe(false);
  expect(input.value).toBe('original suggestion');
  expect(isOpen()).toBe(true);
  expect(posts).toEqual([]);
  expect(app._unsavedInputDrafts).toEqual([]);
});
it('same-text erase/retype and modal replacement cannot be closed by an older accepted operation', async () => {
  const { app, input, isOpen } = await caller();
  const state = app._rmm;
  const sending = app.sendReadMyMind(true);
  input.value = '';
  input.dispatchEvent(new Event('input'));
  input.value = 'original suggestion';
  input.dispatchEvent(new Event('input'));
  expect(await sending).toBe(true);
  expect(app._rmm).toBe(state);
  expect(isOpen()).toBe(true);
});
