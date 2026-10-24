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
  for (const planned of deps.employees()) {
    const allowed = () => deps.employees().some(e => e.id === planned.id && e.owner === planned.owner &&
      e.sessionId === planned.sessionId && e.desiredRunning === true && !e.onVacation);
    if (!running.has(planned.sessionId) || !allowed() || deps.live(planned.sessionId)) continue;
    const saved = deps.saved(planned.sessionId);
    if (!saved || saved.owner !== planned.owner) continue;
    const entry = planRebootRestore([saved.id], { [saved.id]: saved }, () => true, { allowMissingPid: true }).restore[0];
    if (!entry) continue;
    try {
      if (await deps.restore(entry, allowed)) report.connected.push(saved.id);
      else report.failed.push(saved.id);
    } catch { report.failed.push(saved.id); }
  }
  return report;
}
