/**
 * @fileoverview Which agent session may act on which (owner sign-in, agent session scoping).
 *
 * Full control (input, interrupt, read the output, end) needs a **related** target: the caller
 * itself, or its descendant through parents the console recorded. Quick-start records only the
 * caller or one of its own descendants as a child's parent (see the policy's quick-start guard), so
 * the chain cannot be declared.
 *
 * Input only (send text, interrupt with ESC), and never reads or ending a session:
 * - **coordinated**: the target is in a room the caller coordinates, where both the caller's
 *   coordinator seat and the target's membership were made by the owner (or the host, a service, or
 *   before agents could add members). A room an agent created, or a member an agent added, never
 *   counts: an agent cannot grant itself control by building a room.
 * - **upward**: the target is the caller's ancestor, or the coordinator of a room the caller is in,
 *   so a worker can message its parent or coordinator. A session the runtime watcher restarted has
 *   no recorded parent; for this rule only, it inherits its predecessor's, read from the watcher's
 *   record (`restore_source.from -> to`). That file is writable by the agents' uid, so it never
 *   grants more than input.
 * - **keeper**: the caller is bound to a company employee on the owner-set keeper list. Keeping every agent awake is their job, but they see status only (the
 *   session metadata every agent may read), never another session's terminal or transcript. The
 *   list is set only by the host (`reverie owner keepers`), and an employee's session binding only
 *   by the owner or a service, so neither can be self-declared.
 *
 * **admin** (not a session relation): the caller is bound to an employee on the owner-set admin list. The policy lets it call the few company and session routes on the
 * admin list (`policy.ts` ADMIN_ROUTES). Same sources as keeper: the list is set only by the host
 * (`reverie owner admins`) and the binding only by the owner or a service. Never a name or a title.
 */
import { readFileSync, statSync } from 'node:fs';

const MAX_HOPS = 32;

export interface RoomMember {
  sessionId: string;
  role?: string;
  /** The agent session that added this member; absent when the owner, the host or a service did. */
  addedBy?: string;
}

export const ownerMade = (m: RoomMember | undefined): m is RoomMember => !!m && !m.addedBy;

export interface RelationSources {
  /** The recorded parent of a live session or of a persisted (stopped) record. */
  recordedParent(id: string): string | undefined;
  /** A live session or a persisted record with this id exists. */
  known(id: string): boolean;
  rooms(): Iterable<{ members: RoomMember[] }>;
  /** The session this one replaced, per the runtime watcher's record (used for `upward` only). */
  predecessor(id: string): string | undefined;
  /** The company employee bound to a session. */
  employeeOf(sessionId: string): string | undefined;
  /** Owner-set keeper entries: exact employee ids. */
  keepers(): readonly string[];
  /** Owner-set admin entries: exact employee ids. */
  admins(): readonly string[];
}

export interface Relations {
  known(id: string): boolean;
  /** Full control: itself or a recorded descendant. */
  related(caller: string, target: string): boolean;
  /** Input only: a member of a room the caller coordinates, both seats made by the owner. */
  coordinated(caller: string, target: string): boolean;
  /** Input only: an ancestor (watcher lineage included) or the coordinator of a room the caller is in. */
  upward(caller: string, target: string): boolean;
  /** Input only, any session: an owner-set keeper. */
  keeper(caller: string): boolean;
  /** The admin routes (policy.ts ADMIN_ROUTES): an owner-set admin. */
  admin(caller: string): boolean;
}

export function relations(src: RelationSources): Relations {
  // Recorded parents only: the basis of full control.
  const recorded = (id: string) => src.recordedParent(id);
  // For `upward` only: a restarted session takes its predecessor's parent (bounded: the record is external).
  const inherited = (id: string): string | undefined => {
    let current: string | undefined = id;
    for (let hops = 0; current && hops < 8; hops++) {
      const parent = src.recordedParent(current);
      if (parent) return parent;
      current = src.predecessor(current);
    }
    return undefined;
  };
  const isAncestor = (ancestor: string, of: string, parentOf: (id: string) => string | undefined): boolean => {
    let parent = parentOf(of);
    for (let hops = 0; parent && hops < MAX_HOPS; hops++) {
      if (parent === ancestor) return true;
      parent = parentOf(parent);
    }
    return false;
  };
  const rooms = () => [...src.rooms()];
  // The caller's bound employee is on an owner-set list of exact employee ids.
  const listed = (caller: string, list: readonly string[]): boolean => {
    const employee = src.employeeOf(caller);
    if (!employee) return false;
    return list.includes(employee);
  };
  return {
    known: (id) => src.known(id),
    related: (caller, target) => caller === target || isAncestor(caller, target, recorded),
    coordinated: (caller, target) =>
      rooms().some((room) => {
        const seat = room.members.find((m) => m.sessionId === caller);
        return (
          ownerMade(seat) &&
          seat.role === 'coordinator' &&
          ownerMade(room.members.find((m) => m.sessionId === target))
        );
      }),
    upward: (caller, target) =>
      isAncestor(target, caller, inherited) ||
      rooms().some(
        (room) =>
          room.members.some((m) => m.sessionId === target && m.role === 'coordinator') &&
          room.members.some((m) => m.sessionId === caller)
      ),
    keeper: (caller) => listed(caller, src.keepers()),
    admin: (caller) => listed(caller, src.admins()),
  };
}

/**
 * The runtime watcher's lineage: `restore_source.to` replaced `restore_source.from`. Read-only,
 * re-read when the file changes; a missing or unreadable file means no lineage.
 */
export function runtimeLineage(file: string): (id: string) => string | undefined {
  let cached: { mtimeMs: number; map: Map<string, string> } | undefined;
  const load = (): Map<string, string> => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      cached = undefined;
      return new Map();
    }
    if (cached?.mtimeMs === mtimeMs) return cached.map;
    const map = new Map<string, string>();
    try {
      const state = JSON.parse(readFileSync(file, 'utf8')) as { restore_source?: { from?: unknown; to?: unknown } };
      const { from, to } = state.restore_source ?? {};
      if (typeof from === 'string' && typeof to === 'string' && from !== to) map.set(to, from);
    } catch {
      /* unreadable: no lineage */
    }
    cached = { mtimeMs, map };
    return map;
  };
  return (id) => load().get(id);
}
