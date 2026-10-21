import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Session } from './session.js';
import { getCli } from './config/cli-registry/registry.js';
import { selectedSubscription } from './subscription-profiles.js';
import { canUsernameRunPrivilegedCommands, resolveClaudeModeForUsername } from './user-store.js';
import { clampExternalCliBypassForOwner } from './session-config-clamp.js';
import { clampEnvOverridesForOwner } from './session-env-clamp.js';
import { sessionCapacityState } from './web/route-helpers.js';
import { applyWorkspaceHooks } from './hooks-config.js';
import { SseEvent } from './web/sse-events.js';
import type { CompanyResearchBinding, CompanyResearchRuntime } from './company-research-backend.js';
import type { SessionPort, ConfigPort, EventPort, InfraPort } from './web/ports/index.js';
import { envValue } from './config/fleet-env.js';

type RuntimeContext = SessionPort & ConfigPort & EventPort & Pick<InfraPort, 'mux'>;
const REPORT = 'RESEARCH_REPORT.json';

/** Copy launch settings, never another conversation or its resume selector. */
export function freshResearchConfig<T extends object>(config: T | undefined): T | undefined {
  if (!config) return undefined;
  const fresh = structuredClone(config) as Record<string, unknown>;
  for (const key of [
    'resumeSessionId',
    'continueSession',
    'sessionId',
    'session',
    'resumeSession',
    'resumeConversationId',
  ])
    delete fresh[key];
  return fresh as T;
}

/** Real session adapter. The persisted backend supplies the only session ids this adapter may stop. */
export function companySessionRuntime(ctx: RuntimeContext): CompanyResearchRuntime {
  function owned(binding: CompanyResearchBinding): Session | undefined {
    const session = ctx.sessions.get(binding.sessionId);
    if (!session) return undefined;
    if (
      session.owner !== binding.owner ||
      resolve(session.workingDir) !== resolve(binding.workingDir) ||
      envValue(session.getEnvOverridesForPersist() ?? {}, 'RESEARCH_CYCLE_ID') !== binding.cycleId
    )
      throw new Error('Research session ownership mismatch');
    return session;
  }
  async function stop(binding: CompanyResearchBinding): Promise<void> {
    if (owned(binding)) await ctx.cleanupSession(binding.sessionId, true, 'company research session finished');
  }
  return {
    async launch({ binding, employee, prompt, env }) {
      if (ctx.testMode) throw new Error('Autonomous research is disabled in server test mode');
      if (ctx.sessions.has(binding.sessionId)) throw new Error('Research session already exists');
      const main = ctx.sessions.get(employee.sessionId);
      if (!main || main.owner !== employee.owner || main.remote || main.docker)
        throw new Error('Research requires an owned local employee session');
      const entry = getCli(main.mode);
      const ready = entry?.capabilities.composerReadyMark;
      if (!entry || entry.kind === 'shell' || !ready)
        throw new Error('This CLI has no declared research composer readiness marker');
      const capacity = sessionCapacityState(ctx.sessions, employee.owner);
      if (capacity.atGlobalCap || capacity.atUserCap) throw new Error('Research session capacity reached');
      const state = main.toState();
      // Custom endpoints require a separately materialized launch environment. Refuse
      // rather than silently using a different provider or exposing its credentials.
      if (state.customModel) throw new Error('Research requires a standard configured provider');
      if (state.subscriptionProfile && !(await canUsernameRunPrivilegedCommands(employee.owner)))
        throw new Error('Account-profile permission is required for research');
      const launchConfigs = await clampExternalCliBypassForOwner(employee.owner, {
        openCodeConfig: freshResearchConfig(state.openCodeConfig),
        codexConfig: freshResearchConfig(state.codexConfig),
        geminiConfig: freshResearchConfig(state.geminiConfig),
        antigravityConfig: freshResearchConfig(state.antigravityConfig),
        piConfig: freshResearchConfig(state.piConfig),
        grokConfig: freshResearchConfig(state.grokConfig),
        deepSeekConfig: freshResearchConfig(state.deepSeekConfig),
        ompConfig: freshResearchConfig(state.ompConfig),
      });
      const account = await selectedSubscription(state.subscriptionProfile?.id, main.mode);
      const session = new Session({
        id: binding.sessionId,
        workingDir: binding.workingDir,
        mode: main.mode,
        name: `${employee.name} · research`,
        owner: employee.owner,
        parentSessionId: employee.sessionId,
        mux: ctx.mux,
        useMux: true,
        model: state.model,
        claudeMode: await resolveClaudeModeForUsername(main.claudeMode, employee.owner),
        allowedTools: main.allowedTools,
        niceConfig: { enabled: true, niceValue: 10 },
        ...launchConfigs,
        effort: state.effort,
        advisorModel: state.advisorModel,
        envOverrides: {
          ...(await clampEnvOverridesForOwner(employee.owner, main.getEnvOverridesForPersist())),
          ...account.env,
          ...env,
        },
        subscriptionProfile: account.selection,
      });
      if (await ctx.getWorkspaceHooksEnabled()) await applyWorkspaceHooks(binding.workingDir);
      await fs.writeFile(
        join(binding.workingDir, 'RESEARCH_TASK.md'),
        `${prompt}\n\nWork creatively within the time budget. Atomically write your final JSON report to ${REPORT} in this directory before the deadline. This is the completion receipt.\n`,
        { mode: 0o600 }
      );
      await ctx.addSession(session);
      try {
        ctx.persistSessionStateNow(session);
        await ctx.setupSessionListeners(session);
        ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));
        await session.startInteractive();
        const readyDeadline = Math.min(binding.deadlineAt, Date.now() + 90_000);
        while (!session.getTerminalBuffer().includes(ready)) {
          if (!owned(binding) || !session.isRunning() || Date.now() >= readyDeadline)
            throw new Error('Research composer was not ready before launch timeout');
          await delay(500);
        }
        if (Date.now() >= binding.deadlineAt) throw new Error('Research deadline elapsed during startup');
        if (session.paneDialog) throw new Error('Research startup requires an owner to resolve a CLI dialog');
        const sent = await session.writeViaMux('Read RESEARCH_TASK.md and carry out this dedicated research cycle.\r');
        if (!sent) throw new Error('Research task was not delivered');
        ctx.broadcast(SseEvent.SessionInteractive, { id: session.id, mode: session.mode });
      } catch (error) {
        await stop(binding);
        throw error;
      }
    },
    async inspect(binding) {
      // The file is actual tool output. Its contents remain unverified ideas unless
      // an independent tool receipt corroborates them; this adapter grants none.
      const path = join(binding.workingDir, REPORT);
      try {
        const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 256 * 1024 || stat.mtimeMs > binding.deadlineAt)
            throw new Error('Research report is not a bounded on-time regular file');
          const bytes = Buffer.alloc(256 * 1024 + 1);
          let size = 0;
          while (size < bytes.length) {
            const read = await handle.read(bytes, size, bytes.length - size, null);
            if (read.bytesRead === 0) break;
            size += read.bytesRead;
          }
          if (size > 256 * 1024) throw new Error('Research report grew beyond the size bound');
          const response = bytes.subarray(0, size).toString('utf8');
          await stop(binding);
          return { state: 'completed', response, evidence: [] };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          await stop(binding);
          return { state: 'failed', error: 'Research report could not be safely read' };
        }
      }
      const session = owned(binding);
      if (!session) return { state: 'missing' };
      return session.isRunning() && !session.paneExit
        ? { state: 'running' }
        : { state: 'failed', error: 'Dedicated agent exited without a research report' };
    },
    stop,
  };
}
