/** Existing Docker case seed format, independent of restore eligibility and caller authority. */
import { resolvedStockEntry } from './resolved-stock-protocol.js';
import type { DockerCaseSeedProfileName } from '../config/cli-registry/profiles.js';

interface DockerConversationState {
  readonly id: string;
  readonly mode: string;
  readonly docker: { readonly containerName: string } | null | undefined;
  readonly claudeSessionId: string | null;
  readonly claudeSessionIdPending: boolean;
}

const seedCodecs = Object.freeze({
  'session-id-resume-v1': (state: DockerConversationState): string => state.claudeSessionId || state.id,
}) satisfies Readonly<Record<DockerCaseSeedProfileName, (state: DockerConversationState) => string>>;

export function dockerLaunchConversationSeed(
  state: DockerConversationState
): { containerName: string; conversationId: string } | undefined {
  if (!state.docker || state.claudeSessionIdPending) return undefined;
  const pair = resolvedStockEntry(state.mode),
    profile = pair?.shipped.launch.dockerCaseSeed;
  if (!pair || !profile || pair.entry.launch.dockerCaseSeed !== profile) return undefined;
  // The Docker pane wrapper remains the owner of --session-id/--resume even
  // when an owner supplies its legacy command. Whole launch/env equality would
  // incorrectly turn that independent command override into a seed veto.
  return { containerName: state.docker.containerName, conversationId: seedCodecs[profile](state) };
}
