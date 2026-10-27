/** Metadata-only admission over the SAME canonical store/registry; never Goal proof or action authority. */
import type { CompanyStore } from './company-store.js';
import type { SessionManager } from './session-manager.js';
import type { ChatroomService } from './chatroom-service.js';
import type { GoalAuthentication } from './goal-access.js';
import type { CanonicalHealthBindingReader } from './session-health-provider.js';

const canonicalId = /^[A-Za-z0-9_.:-]{1,100}(?![\s\S])/;
const sessionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/;
export class CanonicalHealthMetadataReader implements CanonicalHealthBindingReader {
  constructor(
    private readonly source: {
      store: Pick<CompanyStore, 'file' | 'healthMetadataSnapshot'>;
      sessions: Pick<SessionManager, 'getSession'>;
      retirement: Pick<ChatroomService, 'isRetired'>;
      custody: Pick<GoalAuthentication, 'assertPrivateCustody'>;
    }
  ) {}

  metadataBinding(target: string) {
    try {
      if (!sessionId.test(target)) return;
      const { store, sessions, retirement, custody } = this.source;
      const checkCustody = () => {
        // An accidentally async assertion must not silently grant a synchronous read.
        const result: unknown = custody.assertPrivateCustody(store.file);
        if (result !== undefined) {
          if (result && typeof (result as PromiseLike<unknown>).then === 'function')
            void Promise.resolve(result).catch(() => undefined);
          throw Error('Canonical metadata custody unavailable');
        }
      };
      checkCustody();
      const records = store.healthMetadataSnapshot();
      const matches = records.employees.filter((raw) => (raw as { sessionId?: unknown })?.sessionId === target);
      if (matches.length !== 1) return;
      const e = matches[0] as {
        id?: unknown;
        owner?: unknown;
        sessionGeneration?: unknown;
        bindingMigration?: unknown;
      };
      if (
        typeof e.id !== 'string' ||
        !canonicalId.test(e.id) ||
        (e.owner !== undefined && typeof e.owner !== 'string') ||
        !Number.isSafeInteger(e.sessionGeneration) ||
        (e.sessionGeneration as number) < 1 ||
        e.bindingMigration !== undefined ||
        records.employees.filter((raw) => (raw as { id?: unknown })?.id === e.id).length !== 1
      )
        return;
      const runtime = sessions.getSession(target);
      if (!runtime || runtime.id !== target || runtime.owner !== e.owner || retirement.isRetired(target)) return;
      checkCustody();
      // No isRunning(), display, process, terminal, full snapshot or private content read.
      // STOPPED/VACATION are readable intent, never active Goal authentication.
      if (sessions.getSession(target) !== runtime || runtime.owner !== e.owner || retirement.isRetired(target)) return;
      return Object.freeze({
        owner: e.owner as string | undefined,
        employeeId: e.id,
        sessionId: target,
        sessionGeneration: e.sessionGeneration as number,
      });
    } catch {
      return undefined;
    }
  }
}
