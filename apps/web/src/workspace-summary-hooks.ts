/** Optional executable project hooks require their own shipped writer declaration. */
import { applyCodexTurnSummaryHooks } from './hooks-config.js';
import { resolvedStockEntry } from './utils/resolved-stock-protocol.js';

export async function prepareWorkspaceSummaryHooks(mode: string, workspace: string): Promise<void> {
  const pair = resolvedStockEntry(mode), profile = pair?.shipped.capabilities.workspaceSummaryHooks;
  if (!pair || !profile || pair.entry.capabilities.workspaceSummaryHooks !== profile) return;
  switch (profile) {
    case 'codex-project-v1':
      await applyCodexTurnSummaryHooks(workspace);
      return;
    default: {
      const unsupported: never = profile;
      void unsupported;
      throw new Error('Unsupported project summary-hook writer');
    }
  }
}
