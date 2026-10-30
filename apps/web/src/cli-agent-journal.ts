/**
 * @fileoverview `reverie agent journal`: the caller's own source-linked journal on the office server,
 * keyed to its employee id so it survives a backend change. The server derives the employee from the
 * session, applies the turn gates and checks every cited quote; this client only formats.
 */
import { MEMORY_BRIEF_MAX } from './memory-brief.js';
import type { Command } from 'commander';
import type { AgentDeps } from './cli-agent.js';
import { AGENT_EXIT } from './agent-exit-codes.js';
import { agentJournalImportLegacy, type ImportLegacyOptions } from './cli-agent-journal-import.js';
import { JOURNAL_INTERPRETATION, JOURNAL_PROJECT_SAVES_PER_DAY, type JournalEntryView, type JournalGate, type JournalHeader } from './employee-journal.js';

const bounds = { maxBytes: 256 * 1024, deadlineMs: 10_000 };
const repeat = (value: string, all: string[] = []) => [...all, value];
const repeatId = (value: string, all: number[] = []) => [...all, Number(value)];

/** "10 h ago": a coarse elapsed time beside the exact UTC stamp, never instead of it. */
export function elapsed(at: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return 'time unknown';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
}

function refused(deps: AgentDeps, error: string, gates?: JournalGate[]): number {
  if (deps.json) deps.io.out(JSON.stringify({ success: false, error, ...(gates ? { gates } : {}) }));
  else deps.io.err(gates ? `${error}\n${gateLines(gates)}` : error);
  return AGENT_EXIT.refused;
}
const gateLines = (gates: JournalGate[]) => gates.map(gate => `  ${gate.gate}: ${gate.outcome}${gate.detail ? ` (${gate.detail})` : ''}`).join('\n');

async function call(deps: AgentDeps, method: 'GET' | 'POST', path: string, extra: { query?: Record<string, string | number | undefined>; body?: Record<string, unknown> }) {
  const response = await deps.request(deps.ctx, { method, path, ...extra, bounds });
  const envelope = response.json as { success?: boolean; data?: unknown; error?: string; gates?: JournalGate[] } | undefined;
  return { ok: response.status === 200 && envelope?.success === true, data: envelope?.data, error: envelope?.error ?? `journal request failed (${response.status})`, gates: envelope?.gates };
}

function entryText(entry: JournalEntryView, now: number): string {
  const meta = [entry.annotations?.topics?.length ? `topics: ${entry.annotations.topics.join(', ')}` : '',
    entry.annotations?.importance ? `importance: ${entry.annotations.importance}` : '',
    entry.annotations?.provenance ? `provenance: ${entry.annotations.provenance}` : '',
    entry.project ? `project ${entry.project}, written by ${entry.authorEmployeeId}` : ''].filter(Boolean).join(' · ');
  const lines = [`#${entry.entryId} ${entry.committedAt} (${elapsed(entry.committedAt, now)}) [${entry.tags.join(', ')}]${meta ? ` ${meta}` : ''}`,
    `  ${entry.text}`,
    ...entry.sources.map(source => 'ref' in source ? `  reference: ${source.status} (${source.detail}) ${source.ref}`
      : `  source ${source.roomId}/${source.id}: ${source.status} (${source.detail})${source.quoteWithheld ? '' : ` "${source.quote}"`}`),
    `  interpretation: ${entry.interpretation ?? JOURNAL_INTERPRETATION}`];
  if (entry.supersededBy.length) lines.push(`  superseded by ${entry.supersededBy.map(id => `#${id}`).join(', ')}`);
  return lines.join('\n');
}

export interface JournalSaveOptions {
  room: string; turn: string; text: string; tag: string[]; source?: string[]; quote?: string[];
  topic?: string[]; importance?: string; provenance?: string; supersedes?: number[]; related?: number[]; reason?: string;
  /** Save to a project every employee of the owner can read, instead of your own journal. */
  project?: string;
  /** Non-chat sources (a commit, report or URL); saved and always shown as unverified. */
  ref?: string[];
}

export async function agentJournalSave(deps: AgentDeps, options: JournalSaveOptions): Promise<number> {
  const ids = options.source ?? []; const quotes = options.quote ?? []; const refs = options.ref ?? [];
  if (ids.length !== quotes.length) return refused(deps, 'Each --source needs one --quote, in the same order.');
  if (!ids.length && !refs.length) return refused(deps, 'Give at least one --source with --quote, or a --ref.');
  const annotations = {
    ...(options.topic?.length ? { topics: options.topic } : {}),
    ...(options.importance ? { importance: options.importance } : {}),
    ...(options.provenance ? { provenance: options.provenance } : {}),
    ...(options.supersedes?.length ? { supersedes: options.supersedes } : {}),
    ...(options.related?.length ? { related: options.related } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };
  const draft = { text: options.text, tags: options.tag,
    sources: [...ids.map((id, index) => ({ roomId: options.room, id, quote: quotes[index]! })), ...refs.map(ref => ({ ref }))],
    ...(Object.keys(annotations).length ? { annotations } : {}) };
  try {
    const result = await call(deps, 'POST', '/api/agent/journal/save', { body: { roomId: options.room, turnId: options.turn, draft,
      ...(options.project ? { project: options.project } : {}) } });
    if (!result.ok) return refused(deps, result.error, result.gates);
    const data = result.data as { entryId: number; turnId: string; replayed: boolean; payloadSha256: string };
    if (deps.json) deps.io.out(JSON.stringify({ success: true, data }));
    else deps.io.out(`${data.replayed ? 'Already saved' : 'Saved'} entry #${data.entryId} for turn ${data.turnId} (sha256 ${data.payloadSha256}). Sources checked; interpretation is not verified.`);
    return AGENT_EXIT.ok;
  } catch { return refused(deps, 'Journal save outcome unknown; check `reverie agent journal receipt` before retrying.'); }
}

export async function agentJournalRecall(deps: AgentDeps, words: string[], room?: string, project?: string): Promise<number> {
  try {
    const result = await call(deps, 'GET', '/api/agent/journal/recall', { query: { q: words.join(' '), roomId: room, project } });
    if (!result.ok) return refused(deps, result.error);
    const entries = (result.data as { entries: JournalEntryView[] }).entries;
    if (deps.json) deps.io.out(JSON.stringify({ success: true, data: { entries } }));
    else deps.io.out(entries.length ? entries.map(entry => entryText(entry, (deps.now ?? Date.now)())).join('\n') : 'No matching journal entries.');
    return AGENT_EXIT.ok;
  } catch { return refused(deps, 'Journal recall unavailable.'); }
}

export async function agentJournalMap(deps: AgentDeps, words: string[], options: { room?: string; before?: string; project?: string }): Promise<number> {
  try {
    const result = await call(deps, 'GET', '/api/agent/journal/map', { query: { q: words.length ? words.join(' ') : undefined, roomId: options.room, before: options.before, project: options.project } });
    if (!result.ok) return refused(deps, result.error);
    const data = result.data as { entries: JournalHeader[]; more: boolean };
    if (deps.json) { deps.io.out(JSON.stringify({ success: true, data })); return AGENT_EXIT.ok; }
    const now = (deps.now ?? Date.now)();
    const lines = data.entries.map(entry => `#${entry.entryId} ${entry.committedAt} (${elapsed(entry.committedAt, now)}) ${entry.tags.join(',')}` +
      `${entry.authorEmployeeId ? ` · by ${entry.authorEmployeeId}` : ''}` +
      `${entry.topics.length ? ` · ${entry.topics.join(', ')}` : ''}${entry.importance ? ` · ${entry.importance}` : ''}${entry.superseded ? ' [superseded]' : ''}`);
    const last = data.entries.at(-1);
    if (data.more && last) lines.push(`more: older entries exist (--before ${last.entryId})`);
    deps.io.out(lines.length ? lines.join('\n') : 'No journal entries.');
    return AGENT_EXIT.ok;
  } catch { return refused(deps, 'Journal map unavailable.'); }
}

export async function agentJournalSource(deps: AgentDeps, room: string, messageId: string): Promise<number> {
  try {
    const result = await call(deps, 'GET', '/api/agent/journal/source', { query: { roomId: room, messageId } });
    if (!result.ok) return refused(deps, result.error);
    const data = result.data as { id: string; roomId: string; at: string; from: string; text: string; truncated: boolean };
    if (deps.json) deps.io.out(JSON.stringify({ success: true, data }));
    else deps.io.out(`${data.from} ${data.at} (${elapsed(data.at, (deps.now ?? Date.now)())}) ${data.roomId}/${data.id}\n${data.text}${data.truncated ? '\n[truncated]' : ''}`);
    return AGENT_EXIT.ok;
  } catch { return refused(deps, 'Source message unavailable.'); }
}

export async function agentJournalReceipt(deps: AgentDeps, turnId: string): Promise<number> {
  try {
    const result = await call(deps, 'GET', `/api/agent/journal/receipt/${encodeURIComponent(turnId)}`, {});
    if (!result.ok) return refused(deps, result.error);
    const data = result.data as { status: string; entry?: { entryId: number; committedAt: string; payloadSha256: string; payload: unknown };
      attempts: Array<{ at: string; outcome: string; gates: JournalGate[] }>; evidence: string };
    if (deps.json) { deps.io.out(JSON.stringify({ success: true, data })); return AGENT_EXIT.ok; }
    const lines = [data.entry ? `committed #${data.entry.entryId} ${data.entry.committedAt} sha256 ${data.entry.payloadSha256}\n${JSON.stringify(data.entry.payload)}` : `not_found: ${data.evidence}`];
    for (const attempt of data.attempts) lines.push(`attempt ${attempt.at} ${attempt.outcome}\n${gateLines(attempt.gates)}`);
    deps.io.out(lines.join('\n'));
    return AGENT_EXIT.ok;
  } catch { return refused(deps, 'Journal receipt unavailable.'); }
}

/**
 * The memory brief a session starts with. With --hook-event SessionStart it prints the harness hook JSON, its own entry
 * beside the chat summary so neither crowds the other out of the hook budget; on any failure it prints nothing there.
 */
export async function agentJournalBrief(deps: AgentDeps, hookEvent?: string): Promise<number> {
  if (hookEvent !== undefined && hookEvent !== 'SessionStart') return refused(deps, 'The memory brief is a SessionStart hook only.');
  try {
    const result = await call(deps, 'GET', '/api/agent/memory-brief', {});
    const data = result.ok ? (result.data as { text?: unknown; total?: unknown }) : undefined;
    if (!data || typeof data.text !== 'string' || data.text.length > MEMORY_BRIEF_MAX)
      return hookEvent ? AGENT_EXIT.ok : refused(deps, result.ok ? 'Memory brief unavailable.' : result.error);
    if (hookEvent) deps.io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: hookEvent, additionalContext: data.text } }));
    else if (deps.json) deps.io.out(JSON.stringify({ success: true, data }));
    else deps.io.out(data.text);
    return AGENT_EXIT.ok;
  } catch {
    return hookEvent ? AGENT_EXIT.ok : refused(deps, 'Memory brief unavailable.');
  }
}

export function registerJournalCommands(
  agent: Command,
  run: (json: boolean, verb: (deps: AgentDeps) => Promise<number>) => Promise<void>
): void {
  const journal = agent.command('journal')
    .description('Your own source-linked journal on the office server, kept across backend changes (entries are your account, not verified fact)');
  journal.command('save')
    .description('Save one bounded entry for the message you are acting on; the server checks the turn gates and every quote')
    .requiredOption('-r, --room <id>', 'Room of the turn message and of the cited sources')
    .requiredOption('--turn <message-id>', 'The message you are acting on (read-only and save-reason gates read it)')
    .requiredOption('--text <text>', 'Entry text, at most 1024 UTF-8 bytes')
    .requiredOption('--tag <kind>', 'decision, promise, correction, preference, identity, relationship, open-question, lesson or personal-reflection (repeat, 1-6)', repeat)
    .option('--source <message-id>', 'A cited message (repeat, 1-4; pair each with --quote)', repeat)
    .option('--quote <text>', 'Exact words from the matching --source, at most 256 bytes', repeat)
    .option('--ref <text>', 'A non-chat source such as a commit, report or URL, at most 256 bytes; shown as unverified (repeat)', repeat)
    .option('--topic <topic>', 'Shared history, People, Work, Memory and harness, Games and play, Identity or Other (repeat)', repeat)
    .option('--importance <level>', 'notable, important or keystone')
    .option('--provenance <kind>', 'direct, relayed, reconstructed or unknown')
    .option('--supersedes <entry-id>', 'With --tag correction: an earlier entry this corrects (repeat, 1-4)', repeatId)
    .option('--related <entry-id>', 'An earlier related entry (repeat, 1-4)', repeatId)
    .option('--reason <why>', 'Why save now; required unless the turn message asks you to remember something')
    .option('--project <id>', 'Save to this project (readable by every employee, shown with your name) instead of your own journal')
    .option('--json', 'Machine-readable result and gate record')
    .action((options: JournalSaveOptions & { json?: boolean }) => run(Boolean(options.json), deps => agentJournalSave(deps, options)));
  journal.command('recall <words...>').description('Top two matching entries, with sources re-checked now')
    .option('-r, --room <id>', 'Only entries written while acting in this room')
    .option('--project <id>', "This project's entries, from every employee, instead of your own")
    .option('--json', 'Machine-readable entries (UTC ISO times)')
    .action((words: string[], options: { room?: string; project?: string; json?: boolean }) => run(Boolean(options.json), deps => agentJournalRecall(deps, words, options.room, options.project)));
  journal.command('map [words...]').description('One page of entry headers, newest first')
    .option('-r, --room <id>', 'Only entries written while acting in this room')
    .option('--project <id>', "This project's entries, from every employee, instead of your own")
    .option('--before <entry-id>', 'Continue below this entry id')
    .option('--json', 'Machine-readable page')
    .action((words: string[] | undefined, options: { room?: string; before?: string; json?: boolean }) =>
      run(Boolean(options.json), deps => agentJournalMap(deps, words ?? [], options)));
  journal.command('import-legacy').description('Move your old reverie-memory store into this journal, as imported, unverified entries (run --dry-run first)')
    .option('--dry-run', 'Show what would be imported; write nothing')
    .option('--write', 'Import (safe to repeat: memories already imported are skipped)')
    .option('--include-projects', `Also import project stores, which every employee can then read; they use your own ${JOURNAL_PROJECT_SAVES_PER_DAY} project saves a day`)
    .option('--instance <path>', 'Your own instance config (default: REVERIE_INSTANCE_CONFIG)')
    .option('--json', 'Machine-readable result')
    .action((options: ImportLegacyOptions & { json?: boolean }) => run(Boolean(options.json), deps => agentJournalImportLegacy(deps, options)));
  journal.command('source <message-id>').description('Re-read a cited message as you can see it now')
    .requiredOption('-r, --room <id>', 'Room of the message')
    .option('--json', 'Machine-readable message')
    .action((messageId: string, options: { room: string; json?: boolean }) => run(Boolean(options.json), deps => agentJournalSource(deps, options.room, messageId)));
  journal.command('brief').description('What a new session starts with: who you are, how to use this journal, and your top entries')
    .option('--hook-event <event>', 'Hook output for SessionStart')
    .option('--json', 'Machine-readable brief')
    .action((options: { hookEvent?: string; json?: boolean }) => run(Boolean(options.json), deps => agentJournalBrief(deps, options.hookEvent)));
  journal.command('receipt <turn-id>').description('The saved payload and hash for a turn, and the gates of each recorded attempt')
    .option('--json', 'Machine-readable receipt')
    .action((turnId: string, options: { json?: boolean }) => run(Boolean(options.json), deps => agentJournalReceipt(deps, turnId)));
}
