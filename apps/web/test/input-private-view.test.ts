/** Actual shipped app/journal methods in the browser-input VM. No provider or native input. */
import { afterEach, expect, it, vi } from 'vitest';
import { browserInputFixture, type InputApp } from './helpers/browser-input-fixture.js';
type Dto = {
  id: string;
  name?: string;
  providerDispatchHeld?: unknown;
  providerInputHeld?: unknown;
  providerDispatchHoldKind?: unknown;
  terminalInputHeld?: unknown;
};
type App = InputApp & {
  sessions: Map<string, Dto>;
  _inputStartupRecoveryHolds?: Set<string>;
  _onSessionUpdated(data: { session: Dto }): void;
  _sessionInputHeld(id: string): boolean;
  _refreshInputRecovery(id: string, button: object, status: object): Promise<void>;
};
const sid = 'session-1';
const loaded = (input: boolean): Dto => ({
  id: sid,
  providerDispatchHeld: true,
  providerInputHeld: input,
  providerDispatchHoldKind: 'loaded-intent',
});
let fixture: ReturnType<typeof browserInputFixture>;
afterEach(async () => {
  await fixture?.close();
  vi.restoreAllMocks();
});
async function page(effect?: Parameters<ReturnType<typeof browserInputFixture>['page']>[0]) {
  fixture = browserInputFixture();
  const app = (await fixture.page(effect)) as App;
  Object.assign(app, {
    renderSessionTabs: vi.fn(),
    updateCost: vi.fn(),
    updateSubagentParentNames: vi.fn(),
    _closingSessions: new Set(),
  });
  return app;
}
function update(app: App, session: Dto) {
  app._onSessionUpdated({ session });
}
function controls() {
  return { button: { disabled: false, isConnected: false }, status: { textContent: '' } };
}
it('keeps a known loaded launch fence ephemeral before and after an actual-view DTO', async () => {
  const app = await page();
  update(app, loaded(true));
  expect(app._sessionInputHeld(sid)).toBe(true);
  expect(app._inputRecoveryHolds?.has(sid) ?? false).toBe(false);
  expect(app._inputStartupRecoveryHolds?.has(sid) ?? false).toBe(false);
  update(app, loaded(false));
  expect(app._sessionInputHeld(sid)).toBe(false);
  expect(app.sessions.get(sid)?.providerDispatchHeld).toBe(true);
  expect((await app._inputJournal.snapshot()).holds).toEqual([]);
});
it('an unrelated partial SSE cannot discard a loaded-intent input gate', async () => {
  const app = await page();
  update(app, loaded(true));
  update(app, { id: sid, name: 'partial metadata' });
  expect(app._sessionInputHeld(sid)).toBe(true);
  expect(app._inputRecoveryHolds?.has(sid) ?? false).toBe(false);
  expect(app.sessions.get(sid)).toEqual({ ...loaded(true), name: 'partial metadata' });
  update(app, loaded(false));
  expect(app._sessionInputHeld(sid)).toBe(false);
});
it('refresh updates only full current provider metadata without replay or unrelated metadata replacement', async () => {
  const requests: string[] = [];
  const app = await page(async (url) => {
    requests.push(url);
    return Response.json({ success: true, data: { ...loaded(false), name: 'older HTTP name' } });
  });
  update(app, { ...loaded(true), name: 'newer SSE name' });
  const drain = vi.spyOn(app, '_drainSession'),
    before = await app._inputJournal.snapshot(),
    ui = controls();
  await app._refreshInputRecovery(sid, ui.button, ui.status);
  expect(app._sessionInputHeld(sid)).toBe(false);
  expect(app.sessions.get(sid)).toEqual({ ...loaded(false), name: 'newer SSE name' });
  expect(await app._inputJournal.snapshot()).toEqual(before);
  expect(drain).not.toHaveBeenCalled();
  expect(requests).toEqual(['/api/sessions/' + sid]);
});
it('an older HTTP response cannot overwrite newer SSE provider metadata', async () => {
  let finish!: (value: Response) => void;
  const app = await page(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  update(app, { ...loaded(true), name: 'before' });
  const ui = controls(),
    refresh = app._refreshInputRecovery(sid, ui.button, ui.status);
  update(app, { ...loaded(true), name: 'newer' });
  finish(Response.json({ success: true, data: loaded(false) }));
  await refresh;
  expect(app.sessions.get(sid)).toEqual({ ...loaded(true), name: 'newer' });
  expect(app._sessionInputHeld(sid)).toBe(true);
});
it.each([
  { providerDispatchHeld: true, providerDispatchHoldKind: 'intrinsic', providerInputHeld: true },
  { providerDispatchHeld: true },
  { providerDispatchHeld: true, providerDispatchHoldKind: 'loaded-intent' },
  { providerDispatchHeld: true, providerDispatchHoldKind: 'loaded-intent', providerInputHeld: 'false' },
  { providerDispatchHeld: true, providerDispatchHoldKind: 'intrinsic', providerInputHeld: false },
  { providerDispatchHeld: true, providerDispatchHoldKind: 'unrecognized', providerInputHeld: false },
])('retains intrinsic, legacy and malformed unknown dispatch denial %#', async (fields) => {
  const app = await page();
  update(app, { id: sid, ...fields });
  expect(app._sessionInputHeld(sid)).toBe(true);
  update(app, loaded(false));
  expect(app._sessionInputHeld(sid)).toBe(true);
  expect(app._inputRecoveryHolds?.has(sid)).toBe(true);
});
it.each([
  { ...loaded(false), providerInputHeld: 'false' },
  { ...loaded(false), providerDispatchHoldKind: 'unknown' },
  { id: sid, providerInputHeld: false },
])('refuses malformed refresh metadata without changing the current gate %#', async (data) => {
  const app = await page(async () => Response.json({ success: true, data }));
  update(app, loaded(true));
  const before = app.sessions.get(sid),
    ui = controls();
  await app._refreshInputRecovery(sid, ui.button, ui.status);
  expect(ui.status.textContent).toContain('Could not refresh');
  expect(app.sessions.get(sid)).toBe(before);
  expect(app._sessionInputHeld(sid)).toBe(true);
});
it('a genuine terminal-input unknown is sticky across loaded-view metadata', async () => {
  const app = await page();
  update(app, { ...loaded(false), terminalInputHeld: true });
  update(app, { ...loaded(false), terminalInputHeld: false });
  expect(app._sessionInputHeld(sid)).toBe(true);
  expect(app._inputRecoveryHolds?.has(sid)).toBe(true);
});
it.each(['unconfirmed', 'typed-unsent'] as const)(
  'loaded-view status cannot change or replay the original %s input outcome',
  async (phase) => {
    const app = await page(async () => Response.json({ success: true, data: loaded(false) }));
    const frames: Array<{ seq: number; d: string }> = [];
    update(app, loaded(false));
    app._ws = { readyState: 1, send: (data) => frames.push(JSON.parse(data)) };
    app._wsSessionId = sid;
    expect(await app._sendInputAsync(sid, 'original controlled input')).toBe(true);
    await expect.poll(() => frames.length).toBe(1);
    const seq = frames[0]!.seq;
    await app._onWsInputAck(
      seq,
      phase === 'unconfirmed'
        ? { t: 'ia', seq, unconfirmed: true }
        : { t: 'ia', seq, typedUnsent: true, delivered: false },
      sid
    );
    const before = await app._inputJournal.snapshot();
    if (phase === 'unconfirmed') expect([...before.records, ...before.retained]).toMatchObject([{ phase }]);
    else expect([...before.records, ...before.retained]).toEqual([]);
    update(app, loaded(false));
    const ui = controls();
    await app._refreshInputRecovery(sid, ui.button, ui.status);
    app._redeliverSweep();
    await app._drainSession(sid);
    const after = await app._inputJournal.snapshot();
    expect([...after.records, ...after.retained]).toEqual([...before.records, ...before.retained]);
    expect(frames).toHaveLength(1);
    if (phase === 'unconfirmed') expect(app._sessionInputHeld(sid)).toBe(true);
  }
);
