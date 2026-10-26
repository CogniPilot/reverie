import { setTimeout as delay } from 'node:timers/promises';
import type { CompanyService } from './company-service.js';
import type { PlanService } from './plan-accounts.js';
import type { ChatroomService } from './chatroom-service.js';
import type { SessionPort } from './web/ports/session-port.js';
import type { TerminalMultiplexer } from './mux-interface.js';
import { PlanMoveError, type PlanMoveExecutor } from './plan-move.js';
import { planMoveHarness, planMoveLaunch, runtimeRefreshDigest } from './plan-move-launch.js';
import { composerReadyMark } from './cli-agent.js';
import { fullAccessAlertRoom } from './full-access-default.js';
import { capturePlanProcesses, survivingPlanProcesses } from './plan-move-processes.js';
import { submitRecoveryPrompt } from './company-recovery-prompt.js';

export interface PlanMoveRuntime {
  company: Pick<CompanyService, 'view' | 'rebind'>;
  plans: Pick<PlanService, 'allocations' | 'account'>;
  chat: Pick<ChatroomService, 'rooms' | 'post' | 'auditEntry'> & {delivery?: Pick<ChatroomService['delivery'], 'pauseForMigration'>};
  sessions: SessionPort['sessions'];
  mux: Pick<TerminalMultiplexer, 'getSession' | 'isPaneDead'> & Partial<Pick<TerminalMultiplexer, 'capturePaneText'>>;
  cleanup: SessionPort['cleanupSession'];
  authorized(): boolean;
  actor?: string;
  request(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<unknown>;
  capture?: typeof capturePlanProcesses;
  survivors?: typeof survivingPlanProcesses;
}

export function planMoveExecutor(runtime: PlanMoveRuntime, owner?: string): PlanMoveExecutor {
  const candidates = new Map<string, string>();
  const createdCandidates = new Set<string>();
  const releases: Array<() => void> = [];
  const refreshCandidates = new Map<string, { source: string; digest: string; account: string }>();
  const releaseDelivery = () => { releases.splice(0).forEach(release => release()); };
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
  const policy = (current: ReturnType<typeof session>) => ({
    claudeMode: current.claudeMode, allowedTools: current.allowedTools, niceConfig: current.niceConfig,
    envOverrides: current.getEnvOverridesForPersist?.(),
  });
  const checkRefreshCandidate = async (id: string) => {
    const expected = refreshCandidates.get(id);
    if (!expected) return;
    const account = await runtime.plans.account(expected.account);
    const state = session(id).toState();
    if (state.resumeSessionId || state.codexConfig?.resumeSessionId)
      throw new PlanMoveError('A refreshed replacement must start without provider resume linkage');
    if (!account || runtimeRefreshDigest(state, account, policy(session(id))) !== expected.digest)
      throw new PlanMoveError('The replacement would change the approved runtime settings');
  };

  return {
    verifyRecovery: async (record) => {
      assertAuthorized();
      if (!record.newSession || record.sourceCleanupVerified !== true || record.sourceStopRequested !== true)
        throw new PlanMoveError('Source cleanup was not durably confirmed; inspect before recovery');
      const candidate = assertAlive(record.newSession);
      const candidateState = candidate.toState();
      if (candidateState.remote || candidateState.docker || candidateState.customModel)
        throw new PlanMoveError('Remote, container and custom-model runtimes cannot be adopted as moved subscription sessions');
      const selected = () => {
        const state = candidate.toState(), env = candidate.getEnvOverridesForPersist?.() ?? {};
        return JSON.stringify([state.mode, state.workingDir, candidate.subscriptionProfile?.id,
          env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, state.remote, state.docker, state.customModel]);
      };
      const selection = selected();
      const employee = runtime.company.view(owner).employees.find(row => row.id === record.employeeId);
      const generation = employee?.sessionGeneration;
      const account = await runtime.plans.account(record.toAccount);
      if (!account || candidate.mode !== planMoveHarness(account)) throw new PlanMoveError('The candidate harness or destination plan changed');
      const allocations = await runtime.plans.allocations();
      if (!allocations.accounts.some(row => row.id === record.toAccount && row.sessionIds.includes(record.newSession!)))
        throw new PlanMoveError('The candidate is not allocated to the recorded destination plan');
      const mark = composerReadyMark(candidate.mode);
      const fence = () => {
        assertAuthorized();
        const now = runtime.company.view(owner).employees.find(row => row.id === record.employeeId);
        if (!now || now.sessionId !== record.newSession || now.sessionGeneration !== generation || now.desiredRunning === false || now.onVacation || now.bindingMigration)
          throw new PlanMoveError('The employee binding or running intent changed during recovery');
        const old = runtime.sessions.get(record.oldSession);
        if (old && old.pid && old.muxName && !runtime.mux.isPaneDead(old.muxName))
          throw new PlanMoveError('The original source is still running; recovery will not stop it');
        if (runtime.sessions.get(record.newSession!) !== candidate || selected() !== selection)
          throw new PlanMoveError('The candidate runtime or account selection changed during recovery');
        if (record.purpose === 'runtime-refresh' &&
            (candidate.toState().resumeSessionId || candidate.toState().codexConfig?.resumeSessionId ||
             runtimeRefreshDigest(candidate.toState(), account, policy(candidate)) !== record.runtimeDigest))
          throw new PlanMoveError('The approved refresh runtime changed during recovery');
        assertAlive(record.newSession!);
        if (!mark || !runtime.mux.capturePaneText || !candidate.muxName || candidate.isWorking || candidate.paneDialog ||
          !runtime.mux.capturePaneText(candidate.muxName)?.includes(mark))
          throw new PlanMoveError('The existing candidate is not at its verified composer');
      };
      fence();
      return fence;
    },
    snapshot: async (employeeId, _owner, purpose) => {
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
      let runtimeDigest: string | undefined;
      if (purpose === 'runtime-refresh') {
        const selected = await runtime.plans.account(account.id);
        if (!selected || planMoveHarness(selected) !== saved.mode)
          throw new PlanMoveError('The current runtime and account do not match');
        runtimeDigest = runtimeRefreshDigest(saved, selected, policy(current));
      }
      return {
        sessionId: id,
        name: current.name,
        account: account.id,
        working: current.isWorking,
        mode: saved.mode,
        model: saved.mode === 'codex' ? saved.codexConfig?.model : saved.model,
        ...(runtimeDigest ? { runtimeDigest } : {}),
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
      const source = session(input.sessionId);
      const payload = planMoveLaunch(source.toState(), account, input, policy(source));
      const pauseSource = runtime.chat.delivery?.pauseForMigration(input.sessionId);
      if (pauseSource) releases.push(pauseSource);
      try {
      const response = (await runtime.request('POST', '/api/sessions', payload)) as {
        session?: { id?: unknown }; data?: { session?: { id?: unknown } };
      };
      const id = response?.data?.session?.id ?? response?.session?.id;
      if (typeof id !== 'string') throw new PlanMoveError('The replacement response has no session identifier');
      candidates.set(id, input.handoff);
      createdCandidates.add(id);
      if (input.purpose === 'runtime-refresh')
        refreshCandidates.set(id, { source: input.sessionId, digest: input.runtimeDigest!, account: input.toAccount });
      const pauseCandidate = runtime.chat.delivery?.pauseForMigration(id);
      if (pauseCandidate) releases.push(pauseCandidate);
      return id;
      } catch (error) { releaseDelivery(); throw error; }
    },
    start: async (id) => {
      assertAuthorized();
      await runtime.request('POST', `/api/sessions/${encodeURIComponent(id)}/interactive`);
    },
    ready: async (id) => {
      assertAuthorized();
      await checkRefreshCandidate(id);
      const current = session(id);
      const mark = composerReadyMark(current.mode);
      if (!mark) throw new PlanMoveError('This CLI has no verified readiness marker');
      if (runtime.mux.capturePaneText && current.muxName) {
        const deadline = Date.now() + 90000;
        while (true) {
          assertAuthorized();
          assertAlive(id);
          const text = runtime.mux.capturePaneText(current.muxName);
          if (!current.isWorking && !current.paneDialog && text?.includes(mark)) break;
          if (Date.now() >= deadline) throw new PlanMoveError('The replacement did not reach its composer before the deadline');
          await delay(500);
        }
      } else {
      const result = (await runtime.request(
        'GET',
        `/api/sessions/${encodeURIComponent(id)}/wait-output?from=buffer&timeout=90000&match=${encodeURIComponent(mark)}`
      )) as { data?: { wait?: { matched?: boolean } } };
      if (!result.data?.wait?.matched)
        throw new PlanMoveError('The replacement did not reach its composer before the deadline');
      }
      assertAuthorized();
      assertAlive(id);
      await delay(500);
      assertAlive(id);
      const handoff = candidates.get(id);
      if (!handoff) throw new PlanMoveError('The replacement has no handoff');
      assertAuthorized();
      await checkRefreshCandidate(id);
      await submitRecoveryPrompt(current, handoff, () => runtime.authorized() && runtime.sessions.get(id) === current,
        undefined, {fromUser: true});
      assertAlive(id);
      candidates.delete(id);
      refreshCandidates.delete(id);
      releaseDelivery();
    },
    beforeStop: async (input) => {
      assertAuthorized();
      assertAlive(input.sessionId);
      if (!input.forceBusy && session(input.sessionId).isWorking)
        throw new PlanMoveError('The old session became busy before the replacement started; move rolled back');
      if (input.purpose === 'runtime-refresh') {
        const account = await runtime.plans.account(input.fromAccount);
        const source = session(input.sessionId);
        if (!account || runtimeRefreshDigest(source.toState(), account, policy(source)) !== input.runtimeDigest)
          throw new PlanMoveError('The approved source runtime changed before refresh');
        const candidate = [...refreshCandidates].find(([, expected]) => expected.source === input.sessionId)?.[0];
        if (!candidate) throw new PlanMoveError('The refresh candidate is not registered');
        await checkRefreshCandidate(candidate);
      }
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
      // Rollback may still clean our candidate after logout; stopping the original always needs live owner authority.
      if (!createdCandidates.has(id)) assertAuthorized();
      const current = session(id);
      const roots = [...new Set([current.pid, runtime.mux.getSession(id)?.pid].filter((pid): pid is number => !!pid))];
      const identities = roots.length ? await (runtime.capture ?? capturePlanProcesses)(roots) : [];
      if (!identities.length && !candidates.has(id))
        throw new PlanMoveError('Cannot verify the old process before cleanup');
      if (!createdCandidates.has(id)) assertAuthorized();
      try { await runtime.cleanup(id, true, 'plan_move'); }
      finally { if (createdCandidates.has(id)) releaseDelivery(); }
      candidates.delete(id);
      createdCandidates.delete(id);
      refreshCandidates.delete(id);
      return (runtime.survivors ?? survivingPlanProcesses)(identities);
    },
    audit: async (record) => {
      if (record.owner !== owner) throw new PlanMoveError('The move belongs to another owner', 403);
      // This private append is mandatory before stopping the source. Owner-scoped move history is also persisted by PlanMoves.
      await runtime.chat.auditEntry({
        event: 'plan_move', owner, actor: runtime.actor ?? owner ?? 'owner', moveId: record.id, employeeId: record.employeeId,
        name: record.name, oldSession: record.oldSession, newSession: record.newSession,
        fromAccount: record.fromAccount, toAccount: record.toAccount, phase: record.phase, error: record.error,
        ...(record.purpose ? { purpose: record.purpose } : {}),
      });
      // A channel mirror is optional. Never pick another channel, another owner or a DM when the conventional room is absent.
      try {
        const room = fullAccessAlertRoom(runtime.chat.rooms(), owner);
        if (!room || room.archivedAt) return;
        const from = await runtime.plans.account(record.fromAccount);
        const to = await runtime.plans.account(record.toAccount);
        runtime.chat.post(
          room.id,
          { kind: 'system', name: 'Plans' },
          record.purpose === 'runtime-refresh'
            ? `AUDIT runtime refresh ${record.phase}: ${runtime.actor ?? owner ?? 'Owner'} refreshed ${record.name} on ${from?.label ?? record.fromAccount}${record.error ? `; ${record.error}` : ''}`
            : `AUDIT plan move ${record.phase}: ${runtime.actor ?? owner ?? 'Owner'} moved ${record.name} from ${from?.label ?? record.fromAccount} to ${to?.label ?? record.toAccount}${record.error ? `; ${record.error}` : ''}`
        );
      } catch { console.warn(`[plans] move ${record.id} was audited privately; its optional channel mirror was unavailable`); }
    },
  };
}
