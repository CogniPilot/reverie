/**
 * @fileoverview Server roles and per-channel overrides: the store and the resolver.
 *
 * Five fixed, ranked roles (Owner above all, then Admin, Moderator, Lead, Member). Roles are records
 * of named permissions, so a custom role later is one more record, with no migration. The Owner is
 * never a record and never granted: it is the verified owner login. Owner-only actions (hiring,
 * accounts and sign-in, deleting sessions or rooms, editing roles) are outside this module.
 *
 * Rank decides who may act on whom; it does not decide which permissions a role holds.
 * Contract: reports/roles-contract.md (v2).
 */
import fs from 'node:fs/promises';
import { writeCompanyStateFile } from './company-store.js';

export const OWNER_RANK = 100;

/** Room-scoped permissions: a channel override may allow or deny these. */
export const ROOM_PERMISSIONS = [
  'messages.post',
  'messages.react',
  'messages.report',
  'messages.delete_others',
  'messages.restore',
  'polls.close_others',
  'pins.manage',
  'badges.manage',
  'emotes.remove',
  'members.add',
  'members.remove_others',
  'members.mute',
  'room.settings',
  'roles.override',
] as const;

/** Server-level permissions: never overridable per channel. */
export const SERVER_PERMISSIONS = [
  'members.join_any',
  'room.create',
  'room.appoint_lead',
  'roles.assign',
  'plans.view_all',
] as const;

export type RoomPermission = (typeof ROOM_PERMISSIONS)[number];
export type ServerPermission = (typeof SERVER_PERMISSIONS)[number];
export type Permission = RoomPermission | ServerPermission;

const ROOM_SET = new Set<string>(ROOM_PERMISSIONS);
const SERVER_SET = new Set<string>(SERVER_PERMISSIONS);
export const isRoomPermission = (p: string): p is RoomPermission => ROOM_SET.has(p);
export const isServerPermission = (p: string): p is ServerPermission => SERVER_SET.has(p);
export const isPermission = (p: string): p is Permission => ROOM_SET.has(p) || SERVER_SET.has(p);

export interface Role {
  id: string;
  name: string;
  rank: number;
  locked: boolean;
  permissions: string[];
}

export interface RoleAssignment {
  employeeId: string;
  roleId: string;
  grantedAt: number;
}

export interface RolesState {
  version: 1;
  roles: Role[];
  assignments: RoleAssignment[];
}

export interface OverrideTarget {
  kind: 'role' | 'member';
  id: string;
}

export interface RoomOverride {
  target: OverrideTarget;
  allow: string[];
  deny: string[];
  /**
   * Rank of whoever set it (Owner = 100). It applies only to actors ranked below this, and only an editor at
   * or above it may change or remove it. Absent (an old record) means the Owner set it.
   */
  setByRank?: number;
}

const MEMBER_PERMISSIONS = ['messages.post', 'messages.react', 'messages.report'];
const MODERATOR_PERMISSIONS = [
  ...MEMBER_PERMISSIONS,
  'messages.delete_others',
  'messages.restore',
  'polls.close_others',
  'pins.manage',
  'emotes.remove',
  'members.remove_others',
  'members.mute',
];
const LEAD_PERMISSIONS = [
  ...MEMBER_PERMISSIONS,
  'messages.delete_others',
  'messages.restore',
  'polls.close_others',
  'pins.manage',
  'badges.manage',
  'members.add',
  'members.remove_others',
  'members.mute',
  'room.settings',
  'roles.override',
  'plans.view_all',
];
// Explicit list, no wildcards. Room delete, hiring, accounts and sign-in are owner-only and not here.
const ADMIN_PERMISSIONS = [...ROOM_PERMISSIONS, ...SERVER_PERMISSIONS];

export const MEMBER_ROLE = 'member';
export const LEAD_ROLE = 'lead';

export function seedRoles(): Role[] {
  const role = (id: string, name: string, rank: number, permissions: readonly string[]): Role => ({
    id,
    name,
    rank,
    locked: true,
    permissions: [...permissions],
  });
  return [
    role('admin', 'Admin', 80, ADMIN_PERMISSIONS),
    role('moderator', 'Moderator', 60, MODERATOR_PERMISSIONS),
    role(LEAD_ROLE, 'Lead', 40, LEAD_PERMISSIONS),
    role(MEMBER_ROLE, 'Member', 0, MEMBER_PERMISSIONS),
  ];
}

export const MAX_MUTE_MS = 24 * 60 * 60 * 1000;

/** The caller as the resolver sees it. */
export interface Actor {
  /** The verified owner login. Above every role. */
  owner?: boolean;
  /** A company employee id; absent for a shell or worker session, which is a plain Member. */
  employeeId?: string;
  /** This actor holds the coordinator seat of the room being asked about. */
  lead?: boolean;
  /** The actor's member id in the room, for member overrides. */
  memberId?: string;
  /** This actor holds the coordinator seat of at least one room. Counts for server-level permissions only. */
  leadOfAny?: boolean;
}

function parseState(raw: unknown): RolesState {
  const o = raw as Partial<RolesState> | null;
  if (!o || o.version !== 1 || !Array.isArray(o.roles) || !Array.isArray(o.assignments)) throw new Error('roles.json is malformed');
  return o as RolesState;
}

/** One writer per instance; `roles.json` is 0600 and replaced atomically. */
export class RolesStore {
  private state: RolesState = { version: 1, roles: seedRoles(), assignments: [] };
  private chain: Promise<unknown> = Promise.resolve();

  /** `seedAssignments` is applied once, when the file does not exist yet (the initial holders, from config). */
  constructor(
    readonly file: string,
    private readonly seedAssignments: Array<{ employeeId: string; roleId: string }> = [],
    private readonly now: () => number = Date.now,
    private readonly warn: (message: string) => void = (m) => console.warn(m)
  ) {}

  async init(): Promise<void> {
    try {
      this.state = parseState(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = {
        version: 1,
        roles: seedRoles(),
        assignments: this.seedAssignments.map((a) => ({ ...a, grantedAt: this.now() })),
      };
      await this.save(this.state);
    }
    // The locked roles always match the code, so a permission added later reaches them without a migration.
    const locked = new Map(seedRoles().map((r) => [r.id, r]));
    const custom = this.state.roles.filter((r) => !locked.has(r.id)).flatMap((r) => this.checkedCustomRole(r));
    this.state = { ...this.state, roles: [...locked.values(), ...custom] };
  }

  /** A custom role from the file, made safe: never the owner id, never at or above the Owner, only known permissions. */
  private checkedCustomRole(r: Role): Role[] {
    if (!r || typeof r.id !== 'string' || !r.id || r.id === 'owner') {
      this.warn(`roles.json: dropped a role with the reserved or missing id "${r?.id}"`);
      return [];
    }
    if (typeof r.rank !== 'number' || !Number.isFinite(r.rank) || r.rank >= OWNER_RANK) {
      this.warn(`roles.json: dropped role "${r.id}": rank must be below ${OWNER_RANK}`);
      return [];
    }
    const given = Array.isArray(r.permissions) ? r.permissions : [];
    const known: string[] = given.filter((p): p is string => typeof p === 'string' && isPermission(p));
    for (const p of given) if (!known.includes(p as string)) this.warn(`roles.json: role "${r.id}": dropped unknown permission ${JSON.stringify(p)}`);
    return [{ ...r, name: String(r.name ?? r.id), locked: false, permissions: [...new Set(known)] }];
  }

  snapshot(): RolesState {
    return structuredClone(this.state);
  }

  role(id: string): Role | undefined {
    return this.state.roles.find((r) => r.id === id);
  }

  assignedRole(employeeId: string | undefined): Role {
    const a = employeeId ? this.state.assignments.find((x) => x.employeeId === employeeId) : undefined;
    return (a && this.role(a.roleId)) || (this.role(MEMBER_ROLE) as Role);
  }

  private save(next: RolesState): Promise<void> {
    return writeCompanyStateFile(this.file, JSON.stringify(next, null, 2) + '\n');
  }

  /** Give an employee a role, or take it away (`null`). The caller has already checked `roles.assign` and rank. */
  assign(employeeId: string, roleId: string | null): Promise<{ before: string | null; after: string | null }> {
    const run = this.chain.then(async () => {
      if (roleId !== null && !this.role(roleId)) throw new Error(`No such role: ${roleId}`);
      if (roleId === MEMBER_ROLE) roleId = null;
      const next = structuredClone(this.state);
      const before = next.assignments.find((a) => a.employeeId === employeeId)?.roleId ?? null;
      next.assignments = next.assignments.filter((a) => a.employeeId !== employeeId);
      if (roleId) next.assignments.push({ employeeId, roleId, grantedAt: this.now() });
      await this.save(next);
      this.state = next;
      return { before, after: roleId };
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /** The permissions an actor holds in a room before overrides, and its rank. */
  base(actor: Actor): { permissions: Set<string>; rank: number; roleIds: string[] } {
    if (actor.owner) return { permissions: new Set([...ROOM_PERMISSIONS, ...SERVER_PERMISSIONS]), rank: OWNER_RANK, roleIds: ['owner'] };
    const roles = [this.role(MEMBER_ROLE) as Role, this.assignedRole(actor.employeeId)];
    if (actor.lead) roles.push(this.role(LEAD_ROLE) as Role);
    const permissions = new Set<string>();
    for (const r of roles) for (const p of r.permissions) permissions.add(p);
    return { permissions, rank: Math.max(...roles.map((r) => r.rank)), roleIds: [...new Set(roles.map((r) => r.id))] };
  }

  /** The effective permissions of an actor in a room: base, then role overrides, then its member override. */
  effective(actor: Actor, overrides: readonly RoomOverride[] = []): { permissions: Set<string>; rank: number } {
    const { permissions, rank, roleIds } = this.base(actor);
    if (actor.owner) return { permissions, rank };
    const apply = (o: RoomOverride) => {
      for (const p of o.deny) if (isRoomPermission(p)) permissions.delete(p);
      for (const p of o.allow) if (isRoomPermission(p)) permissions.add(p);
    };
    // An override binds only actors ranked below whoever set it, so a Lead's deny on @member never reaches a Moderator.
    const binds = (o: RoomOverride) => rank < (o.setByRank ?? OWNER_RANK);
    for (const o of overrides) if (o.target.kind === 'role' && roleIds.includes(o.target.id) && binds(o)) apply(o);
    for (const o of overrides) if (o.target.kind === 'member' && actor.memberId && o.target.id === actor.memberId && binds(o)) apply(o);
    return { permissions, rank };
  }

  can(actor: Actor, permission: Permission, overrides: readonly RoomOverride[] = []): boolean {
    if (actor.owner) return true;
    // A server-level permission ignores channel overrides, and counts the Lead seat of any room, not just this one.
    if (isServerPermission(permission)) return this.effective({ ...actor, lead: actor.lead || actor.leadOfAny }, []).permissions.has(permission);
    return this.effective(actor, overrides).permissions.has(permission);
  }

  /**
   * May `actor` act on a target ranked `targetRank` (delete their message, remove, mute)? The Owner is never
   * a target: pass `targetIsOwner` and it is refused. Equal rank is refused.
   */
  outranks(actor: Actor, targetRank: number, targetIsOwner = false): boolean {
    if (targetIsOwner) return false;
    if (actor.owner) return true;
    return this.base(actor).rank > targetRank;
  }

  /** Rank of a target in a room (same collection rules as an actor). */
  rankOf(target: Actor): number {
    return this.base(target).rank;
  }

  /**
   * Is this override edit allowed? The editor may only allow or deny permissions they hold, only for targets ranked
   * below them, only room-scoped permissions, and never on their own member override. An existing override on
   * the same target may be changed or removed only by an editor at or above the rank that set it. An empty
   * allow and deny is a removal, so the delete route calls this too. `setByRank` in the result is what to store.
   */
  checkOverrideEdit(
    editor: Actor,
    edit: { target: OverrideTarget; allow: string[]; deny: string[]; targetRank: number },
    overrides: readonly RoomOverride[] = []
  ): { ok: true; setByRank: number } | { ok: false; reason: string } {
    for (const p of [...edit.allow, ...edit.deny]) {
      if (isServerPermission(p)) return { ok: false, reason: `${p} is a server-level permission and cannot be overridden per channel` };
      if (!isRoomPermission(p)) return { ok: false, reason: `Unknown permission: ${p}` };
    }
    if (editor.owner) return { ok: true, setByRank: OWNER_RANK };
    if (!this.can(editor, 'roles.override', overrides)) return { ok: false, reason: 'You cannot edit overrides in this room' };
    if (edit.target.kind === 'member' && editor.memberId && edit.target.id === editor.memberId)
      return { ok: false, reason: 'You cannot change your own member override' };
    const mine = this.effective(editor, overrides);
    if (edit.targetRank >= mine.rank) return { ok: false, reason: 'You can only edit overrides for targets ranked below you' };
    const existing = overrides.find((o) => o.target.kind === edit.target.kind && o.target.id === edit.target.id);
    if (existing && mine.rank < (existing.setByRank ?? OWNER_RANK))
      return { ok: false, reason: 'That override was set by someone ranked above you' };
    for (const p of [...edit.allow, ...edit.deny])
      if (!mine.permissions.has(p)) return { ok: false, reason: `You do not hold ${p} in this room` };
    return { ok: true, setByRank: mine.rank };
  }

  /** May `actor` assign `roleId` to someone currently holding `currentRoleId`? Never at or above own rank, never beyond own permissions. */
  checkAssign(actor: Actor, roleId: string | null, currentRoleId: string | null): { ok: true } | { ok: false; reason: string } {
    if (actor.owner) return { ok: true };
    if (!this.can(actor, 'roles.assign')) return { ok: false, reason: 'You cannot assign roles' };
    const rank = this.base(actor).rank;
    for (const id of [roleId, currentRoleId]) {
      if (!id) continue;
      const r = this.role(id);
      if (!r) return { ok: false, reason: `No such role: ${id}` };
      if (r.rank >= rank) return { ok: false, reason: 'You can only assign or remove roles ranked below your own' };
      const mine = this.base(actor).permissions;
      if (r.permissions.some((p) => !mine.has(p))) return { ok: false, reason: 'You cannot grant permissions you do not hold' };
    }
    return { ok: true };
  }
}

/**
 * The first role holders from a JSON array of {employeeId, roleId}. Unset gives none; a malformed value gives none
 * and an entry that is not usable (no ids, unknown role, or member) is dropped. Each drop is reported to `warn`.
 */
export function seedAssignmentsFromEnv(raw: string | undefined, warn: (line: string) => void = () => undefined): Array<{ employeeId: string; roleId: string }> {
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    warn('[roles] REVERIE_ROLES_SEED is not valid JSON; no first role holders were seeded');
    return [];
  }
  if (!Array.isArray(list)) {
    warn('[roles] REVERIE_ROLES_SEED is not a JSON array; no first role holders were seeded');
    return [];
  }
  const known = new Set(seedRoles().map((r) => r.id));
  const out: Array<{ employeeId: string; roleId: string }> = [];
  list.forEach((a: unknown, i: number) => {
    const e = a as { employeeId?: unknown; roleId?: unknown } | null;
    if (!e || typeof e.employeeId !== 'string' || !e.employeeId || typeof e.roleId !== 'string') {
      warn(`[roles] REVERIE_ROLES_SEED entry ${i} dropped: it needs a string employeeId and roleId`);
    } else if (e.roleId === MEMBER_ROLE) {
      warn(`[roles] REVERIE_ROLES_SEED entry ${i} dropped: member is the default, not an assignment`);
    } else if (!known.has(e.roleId)) {
      warn(`[roles] REVERIE_ROLES_SEED entry ${i} dropped: unknown role "${e.roleId}"`);
    } else {
      out.push({ employeeId: e.employeeId, roleId: e.roleId });
    }
  });
  return out;
}

/** A mute length in ms, clamped to the 24 h maximum; undefined or non-positive is refused by the caller. */
export function clampMute(ms: number): number {
  return Math.min(Math.max(0, Math.floor(ms)), MAX_MUTE_MS);
}
