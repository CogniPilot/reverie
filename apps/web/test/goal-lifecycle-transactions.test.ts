/** Actual process/CAS/crash and migration-await controls; private synthetic files and inert chat port only. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyService } from '../src/company-service.js';
import type { CompanyState } from '../src/company-types.js';
import { goalFixture } from './helpers/goal-test-fixture.js';

describe('Goal canonical transactions and session fences', () => {
  let f: Awaited<ReturnType<typeof goalFixture>>;
  const children: ChildProcess[] = [];
  const runtimeSessions = new Map<string, {id: string; name: string; owner: string}>();
  beforeEach(async () => {
    f = await goalFixture();
    runtimeSessions.clear();
    for (const id of ['s', 's2']) runtimeSessions.set(id, {id, name: id, owner: 'a'});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
    await f.cleanup();
  });

  async function script(mode: 'transition' | 'crash-in-mutate' | 'crash-after-commit') {
    const path = join(f.directory, mode + '.cjs');
    await build({
      stdin: {
        contents: `
      import { CompanyStore } from './src/company-store.ts';
      import { GoalLifecycle } from './src/goal-lifecycle.ts';
      (async () => {
        const file=process.argv[2]; const input=JSON.parse(process.argv[3]);
        const store=new CompanyStore(file); await store.init();
        const actor={kind:'employee',owner:'a',employeeId:'w',sessionId:'s',sessionGeneration:1};
        const auth={authenticate:async c=>c==='synthetic-worker'?actor:undefined,
          assertCurrent:(_p,c)=>{if(c!=='synthetic-worker')throw Error('denied');},
          assertPrivateCustody:p=>{if(p!==file)throw Error('wrong fixture file');}};
        const goals=new GoalLifecycle(store,()=>2000,auth);
        process.once('message', async()=>{
          try {
            if(${JSON.stringify(mode)}==='crash-in-mutate') {
              await store.update(()=>{process.send({locked:true}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);});
            } else {
              const result=await goals.transition(input,'synthetic-worker');
              if(${JSON.stringify(mode)}==='crash-after-commit') {
                process.send({committed:true}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
              } else process.send({outcome:'accepted',receipt:result.receipt},()=>process.disconnect());
            }
          } catch(error) {process.send({outcome:'rejected',code:error.code},()=>process.disconnect());}
        });
        process.send({ready:true});
      })().catch(error=>{console.error(error);process.exit(2);});`,
        resolveDir: process.cwd(),
        sourcefile: 'synthetic-goal-writer.ts',
      },
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'cjs',
      outfile: path,
      logLevel: 'silent',
    });
    return path;
  }
  async function child(path: string, input: object) {
    const process = fork(path, [f.file, JSON.stringify(input)], {
      env: { ...globalThis.process.env, NODE_PATH: join(globalThis.process.cwd(), 'node_modules') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(process);
    let stderr = '';
    process.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const ready = await Promise.race([
      once(process, 'message'),
      once(process, 'exit').then(([code]) => {
        throw Error('Synthetic child exited ' + code + ': ' + stderr);
      }),
    ]);
    expect(ready[0]).toEqual({ ready: true });
    return process;
  }

  it('has exactly one winner across two barrier-synchronized real processes and retains its acknowledged receipt', async () => {
    const active = await f.active();
    const writer = await script('transition');
    const first = await child(writer, f.command(active, 'REVIEW'));
    const second = await child(writer, f.command(active, 'REVIEW'));
    const answers = [once(first, 'message'), once(second, 'message')];
    first.send('go');
    second.send('go');
    const results = (await Promise.all(answers)).map(([result]) => result);
    expect(results.filter((r) => r.outcome === 'accepted')).toHaveLength(1);
    expect(results.find((r) => r.outcome === 'rejected').code).toBe('GOAL_CONFLICT');
    const persisted = JSON.parse(await fs.readFile(f.file, 'utf8')).goals[0];
    expect(persisted.transitionSequence).toBe(3);
    expect(persisted.transitions.at(-1)).toEqual(results.find((r) => r.outcome === 'accepted').receipt);
    expect(persisted.transitions).toHaveLength(3);
  });

  it('releases a dead writer lock without deleting the persistent lock inode or acknowledging an uncommitted update', async () => {
    const active = await f.active();
    const process = await child(await script('crash-in-mutate'), {});
    const locked = once(process, 'message');
    process.send('go');
    expect((await locked)[0]).toEqual({ locked: true });
    const exit = once(process, 'exit');
    process.kill('SIGKILL');
    await exit;
    const result = await f.goals.transition(f.command(active, 'REVIEW'), 'worker');
    if (result.visibility !== 'full') throw new Error('Assigned worker must receive a full result');
    expect(result.goal.transitionSequence).toBe(3);
    expect(result.goal.transitions).toHaveLength(3);
    expect((await fs.stat(f.file + '.lock')).isFile()).toBe(true);
  });

  it('reconciles a durable commit whose process died before acknowledgment without a duplicate receipt', async () => {
    const active = await f.active();
    const input = f.command(active, 'REVIEW');
    const process = await child(await script('crash-after-commit'), input);
    const committed = once(process, 'message');
    process.send('go');
    expect((await committed)[0]).toEqual({ committed: true });
    const exit = once(process, 'exit');
    process.kill('SIGKILL');
    await exit;
    const persisted = JSON.parse(await fs.readFile(f.file, 'utf8')).goals[0];
    const replay = await f.goals.transition(input, 'worker');
    expect(replay.goal).toEqual(persisted);
    expect(replay.receipt).toEqual(persisted.transitions.at(-1));
    expect((await f.goals.get(active.id, 'owner')).transitions).toHaveLength(3);
  });

  it('rechecks authenticated authority after temporary-file sync and refuses before canonical rename', async () => {
    const active = await f.active();
    const before = await fs.readFile(f.file, 'utf8');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          f.revoked.add('worker');
        };
      }
      return handle;
    });
    await expect(f.goals.transition(f.command(active, 'REVIEW'), 'worker')).rejects.toMatchObject({
      code: 'GOAL_FORBIDDEN',
    });
    expect(await fs.readFile(f.file, 'utf8')).toBe(before);
  });

  it('fences grant expiry that occurs during persistence before the commit', async () => {
    const reviewed = await f.review();
    const grant = await f.grant(reviewed);
    const before = await fs.readFile(f.file, 'utf8');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          f.clock.now = grant.expiresAt;
        };
      }
      return handle;
    });
    await expect(
      f.goals.transition(f.command(reviewed, 'DONE', { verifierGrantId: grant.id }), 'verifier')
    ).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    expect(await fs.readFile(f.file, 'utf8')).toBe(before);
  });

  function company(replaceSession: () => Promise<void>) {
    return new CompanyService(f.store, {
      getSession: (id) => runtimeSessions.get(id),
      chatrooms: {
        rooms: () => [],
        room: () => undefined,
        addMember: () => {
          throw Error('unused');
        },
        setStatus: () => {
          throw Error('unused');
        },
        replaceSession,
      },
      research: {
        start: async () => {
          throw Error('unused');
        },
        inspect: async () => undefined,
        stop: async () => {},
      },
    });
  }

  it('retains an unconfirmed migration generation and fences both sessions without replay or Goal adoption', async () => {
    const active = await f.active();
    f.principals.newWorker = { kind: 'employee', owner: 'a', employeeId: 'w', sessionId: 's2', sessionGeneration: 2 };
    const cause = Error('synthetic migration failure');
    const migrating = company(async () => {
      expect(f.store.snapshot().employees.find((e) => e.id === 'w')?.bindingMigration).toMatchObject({
        from: 's',
        to: 's2',
      });
      for (const token of ['worker', 'newWorker'])
        await expect(f.goals.transition(f.command(active, 'ACTIVE'), token)).rejects.toMatchObject({
          code: 'GOAL_FORBIDDEN',
        });
      await expect(migrating.rebind('w', 'a', 's2')).rejects.toMatchObject({ status: 409 });
      throw cause;
    });
    const failure = await migrating.rebind('w', 'a', 's2').then(
      () => {throw Error('Expected an unconfirmed migration');}, error => error);
    expect(failure).toMatchObject({status: 409, message: expect.stringContaining('publication is unconfirmed')});
    expect(failure.cause).toBe(cause);
    expect(migrating.replacementPublicationRecovery(failure, runtimeSessions.get('s2')!,
      {employeeId: 'w', replacesSessionId: 's'}, 'a')).toMatchObject({employeeId: 'w', sessionId: 's2',
      replacesSessionId: 's', sourceGeneration: 1, reason: 'binding-publication-unconfirmed'});
    expect(f.store.snapshot().employees.find((e) => e.id === 'w')).toMatchObject({
      sessionId: 's',
      sessionGeneration: 2,
      bindingMigration: {from: 's', to: 's2'},
    });
    expect((await f.goals.get(active.id, 'owner')).sessionGeneration).toBe(1);
    const heldBytes = await fs.readFile(f.file, 'utf8');
    await expect(migrating.rebind('w', 'a', 's2')).rejects.toMatchObject({status: 409});
    for (const token of ['worker', 'newWorker'])
      await expect(f.goals.transition(f.command(active, 'REVIEW'), token)).rejects.toMatchObject({code: 'GOAL_FORBIDDEN'});
    await expect(f.goals.adopt({...f.fence(active), transitionId: 'not-a-reconciliation', nextAction: 'Still held'}, 'owner'))
      .rejects.toMatchObject({code: 'GOAL_FORBIDDEN'});
    expect(await fs.readFile(f.file, 'utf8')).toBe(heldBytes);
    expect(f.store.publicationUnconfirmed).toBe(false); // Writer is healthy; the binding reservation is held.
    expect(runtimeSessions.has('s')).toBe(true); expect(runtimeSessions.has('s2')).toBe(true);
  });

  it('requires explicit owner Goal adoption after a separately completed binding migration', async () => {
    const active = await f.active();
    await company(async () => {}).rebind('w', 'a', 's2');
    expect(f.store.snapshot().employees.find((e) => e.id === 'w')).toMatchObject({
      sessionId: 's2',
      sessionGeneration: 2,
    });
    expect(f.store.snapshot().employees.find((e) => e.id === 'w')?.bindingMigration).toBeUndefined();
    expect((await f.goals.get(active.id, 'owner')).sessionGeneration).toBe(1);
    f.principals.newWorker = { kind: 'employee', owner: 'a', employeeId: 'w', sessionId: 's2', sessionGeneration: 2 };
    await expect(f.goals.transition(f.command(active, 'REVIEW'), 'worker')).rejects.toMatchObject({code: 'GOAL_FORBIDDEN'});
    await expect(f.goals.transition(f.command(active, 'REVIEW'), 'newWorker')).rejects.toMatchObject({
      code: 'GOAL_CONFLICT',
    });
    const adopted = await f.goals.adopt(
      { ...f.fence(active), transitionId: 'adoption', nextAction: 'Owner reviewed rebind' },
      'owner'
    );
    expect(adopted.goal).toMatchObject({ generation: 2, sessionGeneration: 2, sessionId: 's2' });
    expect((await f.move(adopted.goal, 'REVIEW', 'newWorker')).state).toBe('REVIEW');
  });
  it.each(['create', 'create-replay', 'transition', 'transition-replay', 'target-rebind'])(
    'retains manager permission and target fences after temp sync for %s', async operation => {
      await f.store.update(state => { state.employees.find(employee => employee.id === 'v')!.permissions.manageGoals = true; });
      const goal = operation.startsWith('create') ? undefined : await f.active();
      if (operation === 'create-replay') await f.goals.create(f.createInput, 'verifier');
      const command = goal ? f.command(goal, 'REVIEW') : undefined;
      if (operation === 'transition-replay') await f.goals.transition(command!, 'verifier');
      const before = await fs.readFile(f.file, 'utf8');
      let pending: CompanyState | undefined;
      const update = f.store.update.bind(f.store);
      vi.spyOn(f.store, 'update').mockImplementation((mutate, validate, beforeSave) => update(state => {
        pending = state;
        return mutate(state);
      }, validate, beforeSave));
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith('.tmp')) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            expect(pending).toBeDefined();
            if (operation === 'target-rebind') pending!.employees.find(employee => employee.id === 'w')!.sessionGeneration++;
            else pending!.employees.find(employee => employee.id === 'v')!.permissions.manageGoals = false;
          };
        }
        return handle;
      });
      await expect(operation.startsWith('create') ? f.goals.create(f.createInput, 'verifier') :
        f.goals.transition(command!, 'verifier')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
      expect(await fs.readFile(f.file, 'utf8')).toBe(before);
    }
  );

});
