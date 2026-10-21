import { setTimeout as delay } from 'node:timers/promises';
import type { CompanyService } from './company-service.js';
import type { PlanService } from './plan-accounts.js';
import type { ChatroomService } from './chatroom-service.js';
import type { SessionPort } from './web/ports/session-port.js';
import type { TerminalMultiplexer } from './mux-interface.js';
import { PlanMoveError, type PlanMoveExecutor } from './plan-move.js';
import { planMoveLaunch } from './plan-move-launch.js';
import { composerReadyMark } from './cli-agent.js';
import { fullAccessAlertRoom } from './full-access-default.js';
import { capturePlanProcesses, survivingPlanProcesses } from './plan-move-processes.js';

export interface PlanMoveRuntime {
  company: Pick<CompanyService, 'view' | 'rebind'>;
  plans: Pick<PlanService, 'allocations' | 'account'>;
  chat: Pick<ChatroomService, 'rooms' | 'post'>;
  sessions: SessionPort['sessions'];
  mux: Pick<TerminalMultiplexer, 'getSession' | 'isPaneDead'>;
  cleanup: SessionPort['cleanupSession'];
  authorized(): boolean;
  request(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<unknown>;
  capture?: typeof capturePlanProcesses;
  survivors?: typeof survivingPlanProcesses;
}

export function planMoveExecutor(runtime: PlanMoveRuntime, owner?: string): PlanMoveExecutor {
  const candidates = new Map<string, string>();
  const session = (id: string) => {
    const current = runtime.sessions.get(id);
    if (!current || current.owner !== owner) throw new PlanMoveError('The owned session is no longer available');
    return current;
  };
  const assertAuthorized = () => {
    if (!runtime.authorized()) throw new PlanMoveError('The owner sign-in expired; sign in and retry', 403);
  };
  const assertAlive = (id: string) => {
    const current = session(id);
    if (!current.pid || !current.muxName || runtime.mux.isPaneDead(current.muxName))
      throw new PlanMoveError('The candidate pane exited or never became ready');
    return current;
  };
  const binding = (employeeId: string) =>
    runtime.company.view(owner).employees.find((employee) => employee.id === employeeId)?.sessionId;

  return {
    snapshot: async (employeeId) => {
      assertAuthorized();
      const id = binding(employeeId);
      if (!id) throw new PlanMoveError('Unknown current employee', 404);
      const current = session(id);
      const saved = current.toState();
      if (saved.mode !== 'claude' && saved.mode !== 'codex')
        throw new PlanMoveError(
          saved.mode === 'opencode'
            ? 'OpenCode thread moves are not supported yet'
            : 'Custom harnesses cannot move plans in this version'
        );
      if (saved.remote || saved.docker || saved.customModel)
        throw new PlanMoveError('This session type cannot move plans');
      if (!current.pid || !current.muxName || runtime.mux.isPaneDead(current.muxName))
        throw new PlanMoveError('The source pane is not running');
      const allocations = await runtime.plans.allocations();
      const account = allocations.accounts.find((row) => row.sessionIds.includes(id));
      if (!account) throw new PlanMoveError('The current plan allocation is unknown');
      const auditRoom = fullAccessAlertRoom(runtime.chat.rooms(), owner);
      if (!auditRoom || auditRoom.archivedAt) throw new PlanMoveError('The owner audit channel is unavailable');
      return {
        sessionId: id,
        name: current.name,
        account: account.id,
        working: current.isWorking,
        mode: saved.mode,
        model: saved.mode === 'codex' ? saved.codexConfig?.model : saved.model,
      };
    },
    idle: async (id, signal) => {
      const deadline = Date.now() + 5 * 60_000;
      while (session(id).isWorking) {
        assertAuthorized();
        if (Date.now() >= deadline)
          throw new PlanMoveError('Still working after five minutes; move cancelled, retry when idle');
        await delay(500, undefined, { signal });
      }
      signal.throwIfAborted();
    },
    create: async (input) => {
      assertAuthorized();
      const account = await runtime.plans.account(input.toAccount);
      if (!account) throw new PlanMoveError('The destination plan no longer exists', 404);
      const payload = planMoveLaunch(session(input.sessionId).toState(), account, input);
      const response = (await runtime.request('POST', '/api/sessions', payload)) as { session?: { id?: unknown } };
      const id = response?.session?.id;
      if (typeof id !== 'string') throw new PlanMoveError('The replacement response has no session identifier');
      candidates.set(id, input.handoff);
      return id;
    },
    start: async (id) => {
      assertAuthorized();
      await runtime.request('POST', `/api/sessions/${encodeURIComponent(id)}/interactive`);
    },
    ready: async (id) => {
      const current = session(id);
      const mark = composerReadyMark(current.mode);
      if (!mark) throw new PlanMoveError('This CLI has no verified readiness marker');
      const result = (await runtime.request(
        'GET',
        `/api/sessions/${encodeURIComponent(id)}/wait-output?from=buffer&timeout=90000&match=${encodeURIComponent(mark)}`
      )) as { data?: { wait?: { matched?: boolean } } };
      if (!result.data?.wait?.matched)
        throw new PlanMoveError('The replacement did not reach its composer before the deadline');
      assertAlive(id);
      await delay(500);
      assertAlive(id);
      const handoff = candidates.get(id);
      if (!handoff) throw new PlanMoveError('The replacement has no handoff');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new PlanMoveError('The replacement handoff was not acknowledged')),
          12_000
        );
        void current
          .writeViaMux(`${handoff}\r`, {
            fromUser: true,
            onOutcome: (outcome) => {
              clearTimeout(timer);
              if (outcome === 'submitted') resolve();
              else reject(new PlanMoveError('The replacement handoff was not submitted'));
            },
          })
          .then(
            (sent) => {
              if (!sent) {
                clearTimeout(timer);
                reject(new PlanMoveError('The replacement refused its handoff'));
              }
            },
            (error) => {
              clearTimeout(timer);
              reject(error);
            }
          );
      });
      assertAlive(id);
      candidates.delete(id);
    },
    beforeStop: async (input) => {
      assertAuthorized();
      assertAlive(input.sessionId);
      if (!input.forceBusy && session(input.sessionId).isWorking)
        throw new PlanMoveError('The old session became busy while the replacement started; move rolled back');
    },
    binding: (employeeId) => binding(employeeId),
    exists: (id) => {
      const current = runtime.sessions.get(id);
      return (
        !!current &&
        current.owner === owner &&
        !!current.pid &&
        !!current.muxName &&
        !runtime.mux.isPaneDead(current.muxName)
      );
    },
    rebind: async (employeeId, id) => {
      await runtime.company.rebind(employeeId, owner, id, owner ?? 'owner');
    },
    stop: async (id) => {
      const current = session(id);
      const roots = [...new Set([current.pid, runtime.mux.getSession(id)?.pid].filter((pid): pid is number => !!pid))];
      const identities = roots.length ? await (runtime.capture ?? capturePlanProcesses)(roots) : [];
      if (!identities.length && !candidates.has(id))
        throw new PlanMoveError('Cannot verify the old process before cleanup');
      await runtime.cleanup(id, true, 'plan_move');
      candidates.delete(id);
      return (runtime.survivors ?? survivingPlanProcesses)(identities);
    },
    audit: async (record) => {
      const room = fullAccessAlertRoom(runtime.chat.rooms(), owner);
      if (!room || room.archivedAt) throw new PlanMoveError('The owner audit channel is unavailable');
      const from = await runtime.plans.account(record.fromAccount);
      const to = await runtime.plans.account(record.toAccount);
      runtime.chat.post(
        room.id,
        { kind: 'system', name: 'Plans' },
        `AUDIT plan move ${record.phase}: ${owner ?? 'Owner'} moved ${record.name} from ${from?.label ?? record.fromAccount} to ${to?.label ?? record.toAccount}${record.error ? `; ${record.error}` : ''}`
      );
    },
  };
}
