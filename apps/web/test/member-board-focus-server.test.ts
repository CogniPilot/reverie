/**
 * The server wiring behind each member's 'doing'-card focus, on a real WebServer: every committed
 * Board write reaches the chat service, the Board copy the chat service reads follows each revision, a refused write
 * announces nothing, and a listener that throws never undoes the write. The suite's setup gives it a temporary HOME.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';

let server: WebServer;
beforeAll(async () => {
  server = new WebServer(0, false, true, '127.0.0.1');
  await server.start();
});
afterAll(async () => {
  await server.stop();
});

it('announces every committed Board write to the chat service and reads the Board as of each revision', async () => {
  const s = server as unknown as {
    chatroomService: { noteBoardChanged(): void; deps: { boardIssues(owner?: string): Array<Record<string, unknown>> } };
    boardStore: { update<T>(o: { ifRev?: number }, m: (state: { issues: Array<Record<string, unknown>> }) => T): Promise<unknown> };
  };
  const spy = vi.spyOn(s.chatroomService, 'noteBoardChanged');
  const issues = () => s.chatroomService.deps.boardIssues(undefined);
  const before = issues().length; // reads (and keeps) the copy for the current revision
  const at = Date.now();
  await s.boardStore.update({}, (state) => {
    state.issues.push({ id: 'i-0000beef', title: 'Doing card', status: 'doing', owner: 'emp-1', start: at, end: at + 3_600_000,
      createdAt: at, updatedAt: at, tags: [], links: [], scale: 'hour' });
  });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(issues()).toHaveLength(before + 1);
  expect(issues().find((i) => i.id === 'i-0000beef')).toMatchObject({ status: 'doing', owner: 'emp-1', end: at + 3_600_000 });
  await s.boardStore.update({}, (state) => {
    state.issues.find((i) => i.id === 'i-0000beef')!.title = 'Renamed card';
  });
  expect(spy).toHaveBeenCalledTimes(2);
  expect(issues().find((i) => i.id === 'i-0000beef')?.title).toBe('Renamed card');
  // A refused write (stale ifRev) commits nothing and announces nothing; the copy stays the committed one.
  await expect(
    s.boardStore.update({ ifRev: 0 }, (state) => {
      state.issues.find((i) => i.id === 'i-0000beef')!.title = 'Never saved';
    })
  ).rejects.toThrow();
  expect(spy).toHaveBeenCalledTimes(2);
  expect(issues().find((i) => i.id === 'i-0000beef')?.title).toBe('Renamed card');
  // A listener that throws never undoes the write.
  spy.mockImplementationOnce(() => {
    throw new Error('listener failed');
  });
  await s.boardStore.update({}, (state) => {
    state.issues.find((i) => i.id === 'i-0000beef')!.status = 'done';
  });
  expect(issues().find((i) => i.id === 'i-0000beef')?.status).toBe('done');
});
