/**
 * @fileoverview Checks for a sealed review packet before it is published: the parts every packet carries (SHA256SUMS,
 * one bundle, PR-TITLE.txt, PR-BODY.md opening with a `## Branch Naming` section), the commits it carries (the
 * configured publish identities, exactly one sign-off, no attribution), the public text (no team names or board ids), and
 * the room (no open hold). Pure functions over strings, so the publish command and the seal-time check share them and
 * tests need no repository or network.
 */
import { createHash } from 'node:crypto';

export interface Finding {
  check: string;
  detail: string;
}

/** `sha256  path` lines, as `sha256sum` writes them. A malformed line is a finding, never skipped. */
export function parseSums(text: string): { entries: Map<string, string>; findings: Finding[] } {
  const entries = new Map<string, string>();
  const findings: Finding[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trimEnd();
    if (!line) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) {
      findings.push({ check: 'sums', detail: `line ${index + 1} is not "<sha256>  <path>"` });
      continue;
    }
    const path = match[2].replace(/^\.\//, '');
    if (path.startsWith('/') || path.split('/').includes('..'))
      findings.push({ check: 'sums', detail: `${path} leaves the packet` });
    else if (entries.has(path)) findings.push({ check: 'sums', detail: `${path} is listed twice` });
    else entries.set(path, match[1]);
  }
  if (!entries.size && !findings.length) findings.push({ check: 'sums', detail: 'SHA256SUMS lists no files' });
  return { entries, findings };
}

/** Every listed file must hash to its listed digest; `read` returns null for a missing file. */
export function verifySums(entries: Map<string, string>, read: (path: string) => Buffer | null): Finding[] {
  const findings: Finding[] = [];
  for (const [path, digest] of entries) {
    const bytes = read(path);
    if (!bytes) findings.push({ check: 'sums', detail: `${path} is missing` });
    else if (createHash('sha256').update(bytes).digest('hex') !== digest)
      findings.push({ check: 'sums', detail: `${path} does not match its digest` });
  }
  return findings;
}

/** The packet's required parts, judged from the SHA256SUMS listing so an unlisted file can't stand in for one. */
export function checkPacketParts(listed: Iterable<string>): { bundle?: string; findings: Finding[] } {
  const paths = [...listed];
  const bundles = paths.filter((p) => p.endsWith('.bundle') && !p.includes('/'));
  const findings: Finding[] = [];
  if (bundles.length !== 1)
    findings.push({ check: 'parts', detail: `expected one top-level .bundle, found ${bundles.length}` });
  for (const required of ['PR-TITLE.txt', 'PR-BODY.md'])
    if (!paths.includes(required)) findings.push({ check: 'parts', detail: `${required} is not listed in SHA256SUMS` });
  return { bundle: bundles.length === 1 ? bundles[0] : undefined, findings };
}

/** The title is one non-empty line; GitHub caps titles at 256 characters. */
export function checkTitle(text: string): { title?: string; findings: Finding[] } {
  const lines = text.replace(/\n+$/, '').split('\n');
  const title = lines[0]?.trim() ?? '';
  if (!title) return { findings: [{ check: 'title', detail: 'PR-TITLE.txt is empty' }] };
  if (lines.length > 1) return { findings: [{ check: 'title', detail: 'PR-TITLE.txt has more than one line' }] };
  if (title.length > 256) return { findings: [{ check: 'title', detail: 'PR title is over 256 characters' }] };
  return { title, findings: [] };
}

/**
 * PR-BODY.md opens with `## Branch Naming`, then the branch in backticks. The section only carries the branch, so the
 * body that is posted leaves it out.
 */
export function splitBranchNaming(body: string): { branch?: string; publicBody: string; findings: Finding[] } {
  const match = /^## Branch Naming[ \t]*\n+[ \t]*`([^`\n]+)`[ \t]*\n+/.exec(body);
  if (!match)
    return {
      publicBody: body,
      findings: [
        {
          check: 'branch',
          detail: 'PR-BODY.md does not open with a "## Branch Naming" section holding the branch in backticks',
        },
      ],
    };
  return { branch: match[1].trim(), publicBody: body.slice(match[0].length), findings: [] };
}

/** Assistant, model and vendor words that a branch name must not carry (the owner's rule: no AI in branch names). */
const BRANCH_FORBIDDEN = ['ai', 'claude', 'codex', 'gpt', 'llm', 'openai', 'anthropic', 'copilot', 'assistant'];

export function checkBranchName(branch: string, teamNames: string[] = []): Finding[] {
  const findings: Finding[] = [];
  if (
    !/^[a-z0-9][a-z0-9._/-]{0,99}$/.test(branch) ||
    branch.includes('..') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock')
  )
    findings.push({ check: 'branch', detail: `"${branch}" is not a plain lowercase branch name` });
  const words = branch
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (const word of words) {
    if (BRANCH_FORBIDDEN.includes(word)) findings.push({ check: 'branch', detail: `branch name contains "${word}"` });
    if (teamNames.some((name) => name.toLowerCase() === word))
      findings.push({ check: 'branch', detail: `branch name contains the team name "${word}"` });
  }
  return findings;
}

export interface CommitInfo {
  sha: string;
  author: string;
  committer: string;
  message: string;
}

/** `git cat-file commit` text: the author and committer identities (without dates) and the message. */
export function parseCommit(sha: string, raw: string): CommitInfo {
  const split = raw.indexOf('\n\n');
  const header = split < 0 ? raw : raw.slice(0, split);
  const identity = (field: string) => new RegExp(`^${field} (.+?) \\d+ [+-]\\d{4}$`, 'm').exec(header)?.[1] ?? '';
  return {
    sha,
    author: identity('author'),
    committer: identity('committer'),
    message: split < 0 ? '' : raw.slice(split + 2),
  };
}

const ATTRIBUTION = /^(co-authored-by:|generated with\b|🤖)/im;

/**
 * Author and committer must each be one of `identities` (`Name <email>`, configured per repository: the canonical form
 * is the maintainer's choice), with exactly one `Signed-off-by` line, naming the author, and no attribution trailer.
 */
export function checkCommit(commit: CommitInfo, identities: readonly string[]): Finding[] {
  const at = commit.sha.slice(0, 8);
  const findings: Finding[] = [];
  if (!identities.includes(commit.author))
    findings.push({ check: 'identity', detail: `${at} author is ${commit.author || 'missing'}` });
  if (!identities.includes(commit.committer))
    findings.push({ check: 'identity', detail: `${at} committer is ${commit.committer || 'missing'}` });
  const signoffs = commit.message.split('\n').filter((line) => /^Signed-off-by:/i.test(line.trim()));
  if (signoffs.length !== 1)
    findings.push({ check: 'dco', detail: `${at} has ${signoffs.length} Signed-off-by lines` });
  else if (signoffs[0].trim() !== `Signed-off-by: ${commit.author}`)
    findings.push({ check: 'dco', detail: `${at} is not signed off by its author` });
  if (ATTRIBUTION.test(commit.message))
    findings.push({ check: 'attribution', detail: `${at} carries an attribution trailer` });
  return findings;
}

const BOARD_ID = /\b[id]-[0-9a-f]{8}\b/;

/**
 * Public text (added lines, commit messages, PR title and body) must not name a team member or a board card or decision.
 * Names match as whole words, case-insensitively.
 */
export function scanPublicText(label: string, text: string, teamNames: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const name of teamNames) {
    if (!name || name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(text))
      findings.push({ check: 'names', detail: `${label} names "${name}"` });
  }
  const id = BOARD_ID.exec(text);
  if (id) findings.push({ check: 'ids', detail: `${label} carries the board id ${id[0]}` });
  return findings;
}

/** Diff entries that must never be published: symlinks, dependency trees and build output. */
export function checkPaths(changes: Array<{ path: string; mode: string }>): Finding[] {
  const findings: Finding[] = [];
  for (const change of changes) {
    if (change.mode === '120000') findings.push({ check: 'paths', detail: `${change.path} is a symlink` });
    if (/(^|\/)(node_modules|target|dist|build|\.venv|__pycache__)(\/|$)/.test(change.path))
      findings.push({ check: 'paths', detail: `${change.path} is dependency or build output` });
  }
  return findings;
}

/** Template changes that the rumoca rule on checked Solve IR asks a reviewer to look at explicitly. */
export function templateChanges(paths: string[]): string[] {
  return paths.filter((p) => /(^|\/)templates\//.test(p) || p.endsWith('.jinja'));
}

export interface RoomMessage {
  id: string;
  at: number;
  from: string;
  text: string;
}

export interface HoldKeys {
  head: string;
  branch: string;
  pr?: string;
  /** Card ids and slice names the room also uses for this packet (T1, C2, a card id). */
  names?: string[];
}

const HOLD_WORDS = /\b(hold|holds|holding|blocker|blocked|wait|do not merge|don't merge)\b|\bNO[- ]GO\b/i;
/** A hold is lifted only in so many words; a bare "go" inside a hold ("hold, don't go yet") must not lift it. */
const LIFT_WORDS =
  /\b(hold|blocker)\s+(is\s+)?(lifted|released|closed|cleared|withdrawn|resolved)\b|\bunblocked\b|\bno longer (blocked|holding)\b/gi;
/** GO as reviewers write it, never the GO inside NO-GO. */
const GO_WORDS = /(?<!\bNO[- ])\bGO\b|\b(approved|lgtm)\b/g;
/** Words that, near a GO or a lift, take it back: "GO remains withheld", "not a GO until CI passes". */
const NEGATION = /\b(not|no|never|withheld|withhold|pending|until|without|unless)\b|n't\b/i;
const NEGATION_REACH = 40;

/** Whether `pattern` (global) occurs in `text` at least once with no negation within reach on either side. */
function plainMatch(text: string, pattern: RegExp): boolean {
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    const around = `${text.slice(Math.max(0, start - NEGATION_REACH), start)} ${text.slice(start + m[0].length, start + m[0].length + NEGATION_REACH)}`;
    if (!NEGATION.test(around)) return true;
  }
  return false;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matchers for the ways a message names this packet. A head matches by its first 8 hex digits (a longer SHA too); every
 * other key matches as a whole token, so "T1" is found in "T1 HOLD" but not in "T12" or "ST1".
 */
function packetMatchers(keys: HoldKeys): RegExp[] {
  const tokens = [keys.branch, keys.pr && `#${keys.pr}`, ...(keys.names ?? [])].filter(
    (key): key is string => !!key && key.trim().length >= 2
  );
  return [
    new RegExp(`(?<![0-9a-f])${escapeRegExp(keys.head.slice(0, 8))}`, 'i'),
    ...tokens.map((key) => new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(key.trim())}(?![A-Za-z0-9_])`, 'i')),
  ];
}

/**
 * Open holds on this packet: a message that names it (head, branch, PR number, card or slice) and uses hold language,
 * NO-GO included, with no later message from the same sender that names the packet and lifts the hold in so many
 * words, or gives a GO naming the exact head; a lift or GO with a negation nearby ("GO remains withheld") is neither.
 * `overridden` holds message ids the publisher has explicitly accepted (`--hold-ok`). Messages come oldest first; the
 * caller makes sure they reach back far enough.
 */
export function openHolds(
  messages: RoomMessage[],
  keys: HoldKeys,
  overridden: ReadonlySet<string> = new Set()
): RoomMessage[] {
  const matchers = packetMatchers(keys);
  const open: RoomMessage[] = [];
  for (const message of messages) {
    if (!matchers.some((m) => m.test(message.text))) continue;
    const holds = HOLD_WORDS.test(message.text);
    // A GO lifts only when it names this exact head and nothing near it takes it back.
    const lifts =
      plainMatch(message.text, LIFT_WORDS) ||
      (!holds && matchers[0].test(message.text) && plainMatch(message.text, GO_WORDS));
    if (lifts) {
      for (let i = open.length - 1; i >= 0; i--) if (open[i].from === message.from) open.splice(i, 1);
    } else if (holds && !overridden.has(message.id)) open.push(message);
  }
  return open;
}

/**
 * Whether the scanned messages provably reach back far enough, judged only by server timestamps and the messages
 * themselves, never by commit dates (whoever makes a commit sets those). `complete` means the room's whole kept history
 * was read. Otherwise the scan must hold the anchor: `anchorId` when the publisher names one (the seal post), else a
 * message naming the head, and the oldest message read must not already name the packet, or earlier ones may be cut off.
 */
export function checkHoldReach(
  messages: RoomMessage[],
  complete: boolean,
  keys: HoldKeys,
  anchorId?: string
): Finding[] {
  const fail = (detail: string): Finding[] => [{ check: 'hold', detail }];
  const matchers = packetMatchers(keys);
  if (anchorId) {
    const index = messages.findIndex((m) => m.id === anchorId);
    if (index < 0)
      return fail(`the --hold-since message ${anchorId.slice(0, 8)} is not among the ${messages.length} messages read`);
    if (!complete && index === 0)
      return fail(`the --hold-since message is the oldest one read, so the scan may stop short of it`);
    return [];
  }
  if (complete) return [];
  if (messages[0] && matchers.some((m) => m.test(messages[0].text)))
    return fail(
      `the oldest of the ${messages.length} messages read already names this packet, so earlier ones may be cut off; pass --hold-since <seal post id>`
    );
  if (!messages.some((m) => matchers[0].test(m.text)))
    return fail(
      `none of the last ${messages.length} messages names ${keys.head.slice(0, 8)}; post the packet in this room or pass --hold-since <seal post id>`
    );
  return [];
}
