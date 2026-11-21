/** Reconnect durable laptops after replacing the disposable website container. */
import type { CompanyEmployee } from './company-types.js';
import type { SessionState } from './types.js';
import { planRebootRestore, type RebootRestoreEntry } from './reboot-restore.js';

export interface LaptopReconnectDeps {
  inventory(): Promise<Record<string, unknown>>;
  employees(): CompanyEmployee[];
  saved(id: string): SessionState | undefined;
  live(id: string): boolean;
  /** Must enforce attach-only at the host broker, including races after inventory. */
  restore(entry: RebootRestoreEntry, allowed: () => boolean): Promise<boolean>;
}

export async function reattachLaptops(deps: LaptopReconnectDeps): Promise<{ connected: string[]; failed: string[] }> {
  const report = { connected: [] as string[], failed: [] as string[] };
  const inventory = await deps.inventory();
  if (!Array.isArray(inventory.runningSessionIds) || inventory.runningSessionIds.length > 256 ||
      !inventory.runningSessionIds.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)))
    throw new Error('The laptop manager does not provide a verified session inventory');
  const running = new Set(inventory.runningSessionIds as string[]);
  for (const { id, owner, sessionId, sessionGeneration } of deps.employees()) {
    const allowed = () => deps.employees().some(e => e.id === id && e.owner === owner &&
      e.sessionId === sessionId && e.sessionGeneration === sessionGeneration && e.desiredRunning === true &&
      !e.onVacation && !e.bindingMigration && !e.dockerBinding);
    if (!running.has(sessionId) || !allowed() || deps.live(sessionId)) continue;
    const saved = deps.saved(sessionId);
    if (!saved || saved.owner !== owner) continue;
    const entry = planRebootRestore([sessionId], { [sessionId]: saved }, () => true, { allowMissingPid: true }).restore[0];
    if (!entry) continue;
    try {
      if (await deps.restore(entry, allowed)) report.connected.push(sessionId);
      else report.failed.push(sessionId);
    } catch { report.failed.push(sessionId); }
  }
  return report;
}
