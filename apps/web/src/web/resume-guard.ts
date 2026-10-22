/**
 * Who may resume which conversation, and which copy of it.
 *
 * A session can be created "resuming" a conversation through any CLI's own config object. An agent may only resume a
 * conversation of its own; anything else would let it read and continue another agent's thread (owner DMs included) or
 * pass for that agent's successor (82). The "continue the latest conversation" forms name no id at all, so for an agent
 * caller they are refused outright.
 *
 * A Claude conversation lives in a config dir (one per subscription account). A session that resumes must find its
 * transcript in ITS OWN config dir. It must never start a fresh thread silently, and never pick one of two copies that
 * differ (a switch between accounts leaves a stale copy behind): both are refused with an error naming every copy,
 * and only an explicit refresh flag copies the newest over the target (the target's old copy is kept as a backup).
 *
 * What blocks: the target has no copy, the target holds copies that differ (under two project slugs), or another account
 * holds a DIFFERENT copy that is NEWER than the target's (resuming would silently lose that work). An older differing copy
 * elsewhere does not block: it is what an account switch always leaves behind, and the target is the live one; it is
 * returned for the caller's warnings. Two differing copies whose times are within AMBIGUOUS_MS cannot be ordered (clock
 * and mtime granularity), so they are refused as well, and a refresh will not pick between them either.
 * A copy with no conversation entry for the id (empty, truncated, not JSON lines) is refused too (422): Claude would
 * answer "No conversation found" and the agent would start over without anyone seeing why.
 *
 * Refresh carries the transcript AND its sidecar dirs (<slug>/<id>/: tool-results, subagents, under whichever slugs the
 * source account has them), each via a temp copy in the target, fsynced, then renamed into place; what was there is
 * kept as <name>.bak-<time>. Every other transcript copy and sidecar dir in the target (any project slug) is set aside
 * the same way, so the next resume finds exactly one. The project's memory/ dir is NOT carried: it belongs to the
 * project in that account, not to one conversation.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

interface ResumeBody {
  resumeSessionId?: string;
  openCodeConfig?: { continueSession?: string } | null;
  codexConfig?: { resumeSessionId?: string } | null;
  geminiConfig?: { resumeSession?: string } | null;
  antigravityConfig?: { resumeConversationId?: string } | null;
  piConfig?: { resumeSessionId?: string; continueSession?: boolean } | null;
  grokConfig?: { resumeSessionId?: string; continueSession?: boolean } | null;
  ompConfig?: { resumeSessionId?: string; continueSession?: boolean } | null;
  deepSeekConfig?: { resumeSessionId?: string; resumeSession?: boolean } | null;
}

/** Gemini's --resume also takes "latest" or a list index: an alias, not an id. */
const GEMINI_ALIAS = /^(latest|\d+)$/i;

export interface ResumeRequest {
  /** Each conversation id the body asks to resume, with the field that asked. */
  ids: Array<{ field: string; id: string }>;
  /** Fields that resume "the latest" conversation (or an alias) without naming an id. */
  latest: string[];
}

/** Every resume a create body asks for, across all CLIs. */
export function requestedResumes(body: ResumeBody): ResumeRequest {
  const ids: ResumeRequest['ids'] = [];
  const latest: string[] = [];
  const id = (field: string, value: unknown) => {
    if (typeof value === 'string' && value) ids.push({ field, id: value });
  };
  id('resumeSessionId', body.resumeSessionId);
  id('openCodeConfig.continueSession', body.openCodeConfig?.continueSession);
  id('codexConfig.resumeSessionId', body.codexConfig?.resumeSessionId);
  id('antigravityConfig.resumeConversationId', body.antigravityConfig?.resumeConversationId);
  for (const [name, cfg] of [
    ['piConfig', body.piConfig],
    ['grokConfig', body.grokConfig],
    ['ompConfig', body.ompConfig],
  ] as const) {
    id(`${name}.resumeSessionId`, cfg?.resumeSessionId);
    if (cfg?.continueSession === true) latest.push(`${name}.continueSession`);
  }
  id('deepSeekConfig.resumeSessionId', body.deepSeekConfig?.resumeSessionId);
  if (body.deepSeekConfig?.resumeSession === true) latest.push('deepSeekConfig.resumeSession');
  const gemini = body.geminiConfig?.resumeSession;
  if (typeof gemini === 'string' && gemini) {
    if (GEMINI_ALIAS.test(gemini)) latest.push('geminiConfig.resumeSession');
    else ids.push({ field: 'geminiConfig.resumeSession', id: gemini });
  }
  return { ids, latest };
}

/** Who may resume a conversation that is not their own (a gone agent's thread). One setting, so the rule changes in one place. */
export type ResumeTakeoverPolicy = 'owner' | 'coordinators';

export const DEFAULT_RESUME_TAKEOVER: ResumeTakeoverPolicy = 'coordinators';

/**
 * Why an agent caller may not create this session, or null. `owns(id)` says whether the conversation is the caller's.
 * `takeover(id)` says whether the caller may continue it anyway (a gone agent's thread, in a room the caller
 * coordinates); it is only asked for conversations the caller does not own, and never for the "latest" forms.
 */
export function resumeRefusalForAgent(
  body: ResumeBody,
  owns: (id: string) => boolean,
  takeover?: (id: string) => boolean
): string | null {
  const { ids, latest } = requestedResumes(body);
  if (latest.length) return `An agent may not resume "the latest" conversation (${latest.join(', ')}): name a conversation of its own`;
  const foreign = ids.find((r) => !owns(r.id) && !takeover?.(r.id));
  if (foreign) return `An agent may only resume a conversation of its own (${foreign.field})`;
  return null;
}

/** The setting: REVERIE_RESUME_TAKEOVER=owner|coordinators. Anything else (or unset) is the default. */
export function resolveTakeoverPolicy(raw: string | undefined = process.env.REVERIE_RESUME_TAKEOVER): ResumeTakeoverPolicy {
  return raw === 'owner' || raw === 'coordinators' ? raw : DEFAULT_RESUME_TAKEOVER;
}

export interface TakeoverSession {
  id: string;
  claudeSessionId?: string | null;
  claudeSessionChain?: readonly string[];
  isRunning(): boolean;
}

/**
 * A row that is only in the persisted state (the console restarted and did not load it) stands for an agent that is gone: it is
 * never running. Its conversation is its recorded id, or the thread named by any CLI's resume field (a Codex row keeps it in
 * `codexConfig.resumeSessionId`).
 */
export function persistedTakeoverSession(id: string, row: Record<string, unknown> | undefined): TakeoverSession {
  const r = row ?? {};
  const cfg = (k: string) => (r[k] as { resumeSessionId?: unknown } | undefined)?.resumeSessionId;
  const thread = [r.claudeSessionId, cfg('codexConfig'), cfg('ompConfig'), r.resumeSessionId].find(
    (v): v is string => typeof v === 'string' && v !== ''
  );
  const chain = Array.isArray(r.claudeSessionChain) ? (r.claudeSessionChain as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
  return { id, claudeSessionId: thread ?? null, claudeSessionChain: chain, isRunning: () => false };
}

export interface TakeoverRoom {
  id: string;
  name: string;
  archivedAt?: number;
  members: ReadonlyArray<{ sessionId: string; role: string }>;
}

export interface TakeoverGrant {
  roomId: string;
  roomName: string;
  /** The gone member whose conversation is being continued. */
  memberSessionId: string;
}

/**
 * May `caller` continue conversation `id` because the agent that owns it is gone? Yes only when the policy is
 * `coordinators`, at least one session holds that conversation, NONE of them is running, and one of them is a member of a
 * live (not archived) room the caller coordinates. A live owner, a room the caller does not coordinate, or a conversation
 * no session holds (nothing proves whose it is) all refuse.
 */
export function resumeTakeoverRoom(input: {
  policy: ResumeTakeoverPolicy;
  caller: string;
  id: string;
  sessions: Iterable<TakeoverSession>;
  rooms: readonly TakeoverRoom[];
}): TakeoverGrant | null {
  if (input.policy !== 'coordinators') return null;
  const holders: TakeoverSession[] = [];
  for (const s of input.sessions) {
    if (s.id === input.id || s.claudeSessionId === input.id || s.claudeSessionChain?.includes(input.id)) holders.push(s);
  }
  if (!holders.length || holders.some((s) => s.isRunning())) return null;
  const ids = new Set(holders.map((s) => s.id));
  for (const room of input.rooms) {
    if (room.archivedAt) continue;
    if (!room.members.some((m) => m.sessionId === input.caller && m.role === 'coordinator')) continue;
    const gone = room.members.find((m) => ids.has(m.sessionId));
    if (gone) return { roomId: room.id, roomName: room.name, memberSessionId: gone.sessionId };
  }
  return null;
}

/** The conversations in this body that the caller does not own: after a null refusal, these are the takeovers to audit. */
export function foreignResumes(body: ResumeBody, owns: (id: string) => boolean): string[] {
  return requestedResumes(body)
    .ids.filter((r) => !owns(r.id))
    .map((r) => r.id);
}

/** The conversation a new row continues, whichever CLI field named it: the row's thread alias (82's same-thread check). */
export function resumeAlias(body: ResumeBody): string | undefined {
  return requestedResumes(body).ids[0]?.id;
}

export interface TranscriptCopy {
  dir: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** Every copy of a Claude conversation's transcript under these config dirs (each searched as <dir>/projects/<slug>/<id>.jsonl). */
export async function findTranscripts(id: string, configDirs: readonly string[]): Promise<TranscriptCopy[]> {
  const copies: TranscriptCopy[] = [];
  for (const dir of [...new Set(configDirs)]) {
    let slugs: string[];
    try {
      slugs = await fs.readdir(join(dir, 'projects'));
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const path = join(dir, 'projects', slug, `${id}.jsonl`);
      try {
        const st = await fs.stat(path);
        if (st.isFile()) copies.push({ dir, path, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Not in this project dir.
      }
    }
  }
  return copies;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Whether the transcript holds at least one conversation entry (a user or assistant line) of this session. */
export async function hasConversationEntry(path: string, id: string): Promise<boolean> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const entry = JSON.parse(line) as { type?: unknown; sessionId?: unknown };
        if (entry?.sessionId === id && (entry.type === 'user' || entry.type === 'assistant')) return true;
      } catch {
        // Not a JSON line: keep looking.
      }
    }
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Differing copies modified this close together cannot be told apart by time: refused, never ordered. */
export const AMBIGUOUS_MS = 2000;

const describe = (c: TranscriptCopy) => `${c.path} (${c.size} bytes, modified ${new Date(c.mtimeMs).toISOString()})`;

export type ResumeCheck =
  | { ok: true; refreshed?: string; setAside?: string[]; olderElsewhere?: string[] }
  | { ok: false; status: 404 | 409 | 422; error: string };

/**
 * The sidecar dirs (<slug>/<id>/: tool-results, subagents) of a conversation in one config dir, by project slug. Claude
 * writes them under the CURRENT working dir's slug, which need not be the slug of the transcript (a conversation resumed
 * from another dir keeps its transcript where it began), so every slug is searched.
 */
async function sidecarsIn(configDir: string, id: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let slugs: string[] = [];
  try {
    slugs = await fs.readdir(join(configDir, 'projects'));
  } catch {
    return found;
  }
  for (const slug of slugs) {
    const dir = join(configDir, 'projects', slug, id);
    try {
      if ((await fs.lstat(dir)).isDirectory()) found.set(slug, dir);
    } catch {
      // None under this slug.
    }
  }
  return found;
}

async function fsyncPath(path: string): Promise<void> {
  const fh = await fs.open(path, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** fsync every file under a tree, and the tree's dirs. */
async function fsyncTree(path: string): Promise<void> {
  const st = await fs.lstat(path);
  if (st.isDirectory()) for (const name of await fs.readdir(path)) await fsyncTree(join(path, name));
  if (st.isDirectory() || st.isFile()) await fsyncPath(path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy `src` (file or dir) over `dest` atomically: a temp copy beside `dest`, fsynced, then a rename. An existing `dest`
 * is kept as <dest>.bak-<stamp> first (a hard link for a file, so `dest` never goes missing; a rename for a dir, put
 * back if the swap fails). On failure the temp copy is removed and `dest` is as it was.
 */
async function replaceAtomically(src: string, dest: string, stamp: string): Promise<void> {
  const tmp = join(dirname(dest), `.${basename(dest)}.tmp-${stamp}`);
  const isDir = (await fs.stat(src)).isDirectory();
  try {
    if (isDir) await fs.cp(src, tmp, { recursive: true, errorOnExist: true, force: false });
    else await fs.copyFile(src, tmp);
    await fsyncTree(tmp);
    if (isDir) {
      const bak = `${dest}.bak-${stamp}`;
      const had = await exists(dest);
      if (had) await fs.rename(dest, bak);
      try {
        await fs.rename(tmp, dest);
      } catch (err) {
        if (had) await fs.rename(bak, dest);
        throw err;
      }
    } else {
      if (await exists(dest)) {
        try {
          await fs.link(dest, `${dest}.bak-${stamp}`);
        } catch {
          await fs.copyFile(dest, `${dest}.bak-${stamp}`);
        }
      }
      await fs.rename(tmp, dest);
    }
    await fsyncPath(dirname(dest));
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

async function differs(a: TranscriptCopy, b: TranscriptCopy): Promise<boolean> {
  return a.size !== b.size || (await sha256(a.path)) !== (await sha256(b.path));
}

/**
 * May a Claude session in `targetDir` resume conversation `id`? Refuses rather than start fresh or pick a copy. With
 * `refresh`, the newest copy (and its sidecar dirs) is copied into the target, and every other target copy set aside.
 */
export async function checkClaudeResume(
  id: string,
  targetDir: string,
  knownDirs: readonly string[],
  refresh = false,
  now: () => number = Date.now
): Promise<ResumeCheck> {
  const copies = await findTranscripts(id, [targetDir, ...knownDirs]);
  if (!copies.length) {
    return { ok: false, status: 404, error: `No transcript for conversation ${id} in any account; refusing to start a fresh thread in its place (create without resumeSessionId for a new conversation)` };
  }
  const newestOf = (list: TranscriptCopy[]) => list.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const unusable = (c: TranscriptCopy) => ({
    ok: false as const,
    status: 422 as const,
    error: `The transcript ${describe(c)} holds no conversation entry for ${id} (empty, truncated or not a Claude transcript); refusing to resume it, since Claude would start over. Repair or remove it, or create without resumeSessionId for a new conversation.`,
  });
  const inTarget = copies.filter((c) => c.dir === targetDir);
  const elsewhere = copies.filter((c) => c.dir !== targetDir);
  let why: string | undefined;
  const older: TranscriptCopy[] = [];
  if (!inTarget.length) {
    why = `it is not in ${targetDir}`;
  } else {
    const own = newestOf(inTarget);
    for (const c of inTarget) if (c !== own && (await differs(c, own))) why = `its copies in ${targetDir} differ`;
    if (!why) {
      for (const c of elsewhere) {
        if (!(await differs(c, own))) continue;
        if (Math.abs(c.mtimeMs - own.mtimeMs) <= AMBIGUOUS_MS) why = `its copies differ and were modified within ${AMBIGUOUS_MS / 1000} s of each other, so which is newer cannot be told`;
        else if (c.mtimeMs > own.mtimeMs) why = `its copies differ and a newer one is in another account`;
        else older.push(c);
      }
    }
    if (!why) {
      if (!(await hasConversationEntry(own.path, id))) return unusable(own);
      return older.length ? { ok: true, olderElsewhere: older.map(describe) } : { ok: true };
    }
  }
  const newest = newestOf(copies);
  if (!refresh) {
    return {
      ok: false,
      status: 409,
      error: `Conversation ${id} cannot be resumed as is: ${why}. Copies: ${copies.map(describe).join('; ')}. Pass refreshResumeFromNewest to copy the newest (${newest.path}) into ${targetDir} (any older copy there is kept as a backup).`,
    };
  }
  for (const c of copies) {
    if (c !== newest && newest.mtimeMs - c.mtimeMs <= AMBIGUOUS_MS && (await differs(c, newest))) {
      return {
        ok: false,
        status: 409,
        error: `Conversation ${id} cannot be refreshed: the newest copies differ and were modified within ${AMBIGUOUS_MS / 1000} s of each other (${describe(newest)}; ${describe(c)}), so which is newest cannot be told. Resolve by hand.`,
      };
    }
  }
  if (!(await hasConversationEntry(newest.path, id))) return unusable(newest);
  const stamp = String(now());
  const slug = basename(dirname(newest.path));
  const dest = join(targetDir, 'projects', slug, `${id}.jsonl`);
  if (dest !== newest.path) {
    // Sidecars first (every slug the source account has them under; the target's under any other slug are set aside),
    // then the transcript. If anything fails, the sidecar changes are undone in reverse, so the target is as it was.
    const undo: Array<() => Promise<void>> = [];
    try {
      const from = await sidecarsIn(newest.dir, id);
      const into = await sidecarsIn(targetDir, id);
      for (const [s, src] of from) {
        const to = join(targetDir, 'projects', s, id);
        const had = into.has(s);
        await fs.mkdir(dirname(to), { recursive: true, mode: 0o700 });
        await replaceAtomically(src, to, stamp);
        undo.push(async () => {
          await fs.rm(to, { recursive: true, force: true });
          if (had) await fs.rename(`${to}.bak-${stamp}`, to);
        });
      }
      for (const [s, old] of into) {
        if (from.has(s)) continue;
        await fs.rename(old, `${old}.bak-${stamp}`);
        undo.push(() => fs.rename(`${old}.bak-${stamp}`, old));
      }
      await fs.mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      await replaceAtomically(newest.path, dest, stamp);
    } catch (err) {
      for (const step of undo.reverse()) await step().catch(() => undefined);
      throw err;
    }
  }
  // Every other copy in the target, under any slug, is set aside, so the next resume finds exactly one.
  const setAsidePaths: string[] = [];
  for (const c of inTarget) {
    if (c.path === dest) continue;
    await fs.rename(c.path, `${c.path}.bak-${stamp}`);
    setAsidePaths.push(c.path);
  }
  return { ok: true, refreshed: dest, ...(setAsidePaths.length ? { setAside: setAsidePaths } : {}) };
}
