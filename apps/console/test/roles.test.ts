import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolesStore, clampMute, MAX_MUTE_MS, type Actor, type RoomOverride } from '../src/roles.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roles-'));
  file = join(dir, 'roles.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OWNER: Actor = { owner: true };
const ADMIN: Actor = { employeeId: 'reviewer' };
const MOD: Actor = { employeeId: 'mod' };
const LEAD: Actor = { employeeId: 'planner', lead: true, memberId: 'planner-m' };
const PLAIN: Actor = { employeeId: 'coordinator', memberId: 'coordinator-m' };
const SHELL: Actor = {};

async function store(): Promise<RolesStore> {
  const s = new RolesStore(file, [{ employeeId: 'reviewer', roleId: 'admin' }, { employeeId: 'worker', roleId: 'admin' }, { employeeId: 'mod', roleId: 'moderator' }]);
  await s.init();
  return s;
}

describe('roles store', () => {
  it('seeds the roles and the initial holders once, 0600, and survives a restart', async () => {
    await store();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = new RolesStore(file, [{ employeeId: 'someone-else', roleId: 'admin' }]);
    await again.init();
    expect(again.assignedRole('reviewer').id).toBe('admin');
    expect(again.assignedRole('someone-else').id).toBe('member'); // seeds apply only when the file is new
    expect(JSON.parse(readFileSync(file, 'utf8')).roles.map((r: { id: string }) => r.id)).toEqual(['admin', 'moderator', 'lead', 'member']);
  });

  it('a session with no employee, or an unassigned one, is a Member', async () => {
    const s = await store();
    expect(s.assignedRole(undefined).id).toBe('member');
    expect(s.can(SHELL, 'messages.post')).toBe(true);
    expect(s.can(SHELL, 'messages.delete_others')).toBe(false);
  });

  it('Member refused / Lead allowed / Moderator allowed / Admin allowed on deleting others messages', async () => {
    const s = await store();
    expect([PLAIN, LEAD, MOD, ADMIN].map((a) => s.can(a, 'messages.delete_others'))).toEqual([false, true, true, true]);
  });

  it('Lead holds what Moderator lacks, only where it holds the seat', async () => {
    const s = await store();
    expect(s.can(LEAD, 'room.settings')).toBe(true);
    expect(s.can({ employeeId: 'planner' }, 'room.settings')).toBe(false); // same person in a room it does not lead
    expect(s.can(MOD, 'room.settings')).toBe(false);
  });

  it('no role holds an edit-others permission, and room delete / hiring are not permissions at all', async () => {
    const s = await store();
    const all = new Set(s.snapshot().roles.flatMap((r) => r.permissions));
    expect([...all].some((p) => /edit_others|room\.delete|hire|account/.test(p))).toBe(false);
  });

  it('rank decides targeting: Moderator cannot act on an Admin, nobody on the Owner', async () => {
    const s = await store();
    expect(s.outranks(MOD, s.rankOf(ADMIN))).toBe(false);
    expect(s.outranks(ADMIN, s.rankOf(MOD))).toBe(true);
    expect(s.outranks(ADMIN, s.rankOf(ADMIN))).toBe(false);
    expect(s.outranks(ADMIN, 0, true)).toBe(false);
    expect(s.outranks(OWNER, s.rankOf(ADMIN))).toBe(true);
  });

  it('overrides: role deny beats base, member allow beats role deny, and an override reaches only its room', async () => {
    const s = await store();
    const room: RoomOverride[] = [
      { target: { kind: 'role', id: 'member' }, allow: [], deny: ['messages.post'] },
      { target: { kind: 'member', id: 'coordinator-m' }, allow: ['messages.post', 'pins.manage'], deny: [] },
    ];
    expect(s.can(PLAIN, 'messages.post', room)).toBe(true);
    expect(s.can(PLAIN, 'pins.manage', room)).toBe(true);
    expect(s.can({ employeeId: 'zed', memberId: 'zed-m' }, 'messages.post', room)).toBe(false);
    expect(s.can(PLAIN, 'pins.manage')).toBe(false); // another room, no override
  });

  it('a server-level permission ignores channel overrides', async () => {
    const s = await store();
    const room: RoomOverride[] = [{ target: { kind: 'role', id: 'admin' }, allow: [], deny: ['messages.post'] }];
    expect(s.can(ADMIN, 'messages.post', room)).toBe(false);
    expect(s.can(ADMIN, 'plans.view_all', [{ target: { kind: 'role', id: 'admin' }, allow: [], deny: ['plans.view_all'] }])).toBe(true);
    expect([PLAIN, LEAD, MOD, ADMIN].map((a) => s.can(a, 'plans.view_all'))).toEqual([false, true, false, true]);
  });

  it('override edits cannot escalate', async () => {
    const s = await store();
    const memberTarget = { kind: 'member' as const, id: 'coordinator-m' };
    // a Lead may grant what it holds to a lower-ranked member
    expect(s.checkOverrideEdit(LEAD, { target: memberTarget, allow: ['pins.manage'], deny: [], targetRank: 0 })).toEqual({ ok: true, setByRank: 40 });
    // not what it lacks
    expect(s.checkOverrideEdit(LEAD, { target: memberTarget, allow: ['emotes.remove'], deny: [], targetRank: 0 }).ok).toBe(false);
    // not against an Admin
    expect(s.checkOverrideEdit(LEAD, { target: { kind: 'member', id: 'reviewer-m' }, allow: [], deny: ['messages.post'], targetRank: s.rankOf(ADMIN) }).ok).toBe(false);
    // not on its own member override
    expect(s.checkOverrideEdit(LEAD, { target: { kind: 'member', id: 'planner-m' }, allow: ['pins.manage'], deny: [], targetRank: 0 }).ok).toBe(false);
    // not a server-level permission
    expect(s.checkOverrideEdit(ADMIN, { target: memberTarget, allow: ['roles.assign'], deny: [], targetRank: 0 }).ok).toBe(false);
    // a Member cannot edit at all; the Owner can
    expect(s.checkOverrideEdit(PLAIN, { target: memberTarget, allow: [], deny: ['messages.post'], targetRank: 0 }).ok).toBe(false);
    expect(s.checkOverrideEdit(OWNER, { target: memberTarget, allow: [], deny: ['messages.post'], targetRank: 0 })).toEqual({ ok: true, setByRank: 100 });
  });

  it('role assignment follows rank: an Admin cannot assign Admin, a Member cannot assign anything, the Owner can', async () => {
    const s = await store();
    expect(s.checkAssign(ADMIN, 'admin', null).ok).toBe(false);
    expect(s.checkAssign(ADMIN, 'moderator', null)).toEqual({ ok: true });
    expect(s.checkAssign(ADMIN, null, 'admin').ok).toBe(false); // cannot remove an equal either
    expect(s.checkAssign(PLAIN, 'moderator', null).ok).toBe(false);
    expect(s.checkAssign(OWNER, 'admin', null)).toEqual({ ok: true });
  });

  it('assign and unassign persist, report before/after, and reject an unknown role', async () => {
    const s = await store();
    expect(await s.assign('coordinator', 'moderator')).toEqual({ before: null, after: 'moderator' });
    const again = new RolesStore(file);
    await again.init();
    expect(again.assignedRole('coordinator').id).toBe('moderator');
    expect(await s.assign('coordinator', null)).toEqual({ before: 'moderator', after: null });
    await expect(s.assign('coordinator', 'nope')).rejects.toThrow(/No such role/);
  });

  it('locked roles always come from the code, so an edited file cannot widen them', async () => {
    const s = await store();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.roles.find((r: { id: string }) => r.id === 'member').permissions.push('roles.assign');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(raw));
    const again = new RolesStore(file);
    await again.init();
    expect(again.can(PLAIN, 'roles.assign')).toBe(false);
    expect(s).toBeTruthy();
  });

  it('a Lead deny on @member binds Members but not Moderators or Admins in that room', async () => {
    const s = await store();
    const leadEdit = s.checkOverrideEdit(LEAD, { target: { kind: 'role', id: 'member' }, allow: [], deny: ['messages.post'], targetRank: 0 });
    expect(leadEdit).toEqual({ ok: true, setByRank: 40 });
    const room: RoomOverride[] = [{ target: { kind: 'role', id: 'member' }, allow: [], deny: ['messages.post'], setByRank: 40 }];
    expect(s.can(PLAIN, 'messages.post', room)).toBe(false);
    expect(s.can(MOD, 'messages.post', room)).toBe(true);
    expect(s.can(ADMIN, 'messages.post', room)).toBe(true);
    expect(s.can(LEAD, 'messages.post', room)).toBe(true); // not ranked below itself
  });

  it('an override set by the Owner binds everyone but the Owner, and a Lead cannot change or delete it', async () => {
    const s = await store();
    const room: RoomOverride[] = [{ target: { kind: 'role', id: 'member' }, allow: [], deny: ['messages.post'], setByRank: 100 }];
    expect([PLAIN, LEAD, MOD, ADMIN].map((a) => s.can(a, 'messages.post', room))).toEqual([false, false, false, false]);
    expect(s.can(OWNER, 'messages.post', room)).toBe(true);
    const target = { kind: 'role' as const, id: 'member' };
    expect(s.checkOverrideEdit(LEAD, { target, allow: [], deny: [], targetRank: 0 }, room).ok).toBe(false); // delete
    expect(s.checkOverrideEdit(LEAD, { target, allow: ['messages.post'], deny: [], targetRank: 0 }, room).ok).toBe(false); // change
    expect(s.checkOverrideEdit(OWNER, { target, allow: [], deny: [], targetRank: 0 }, room).ok).toBe(true);
    // an override without a recorded rank counts as Owner-set
    const old: RoomOverride[] = [{ target, allow: [], deny: ['messages.post'] }];
    expect(s.checkOverrideEdit(LEAD, { target, allow: [], deny: [], targetRank: 0 }, old).ok).toBe(false);
  });

  it('an editor at or above the setter may change or remove an override', async () => {
    const s = await store();
    const target = { kind: 'role' as const, id: 'member' };
    const byLead: RoomOverride[] = [{ target, allow: [], deny: ['messages.post'], setByRank: 40 }];
    expect(s.checkOverrideEdit(LEAD, { target, allow: [], deny: [], targetRank: 0 }, byLead).ok).toBe(true);
    expect(s.checkOverrideEdit(ADMIN, { target, allow: [], deny: [], targetRank: 0 }, byLead).ok).toBe(true);
  });

  it('plans.view_all counts the Lead seat of any room; room permissions still need this room', async () => {
    const s = await store();
    const leadElsewhere: Actor = { employeeId: 'planner', leadOfAny: true };
    expect(s.can(leadElsewhere, 'plans.view_all')).toBe(true);
    expect(s.can(leadElsewhere, 'room.settings')).toBe(false);
    expect(s.can({ employeeId: 'coordinator' }, 'plans.view_all')).toBe(false);
  });

  it('custom roles from the file are validated: rank below Owner, known permissions, no owner id', async () => {
    await store();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.roles.push(
      { id: 'owner', name: 'Owner', rank: 10, locked: false, permissions: [] },
      { id: 'boss', name: 'Boss', rank: 100, locked: false, permissions: ['messages.post'] },
      { id: 'helper', name: 'Helper', rank: 20, locked: false, permissions: ['messages.post', 'rm.rf', 'pins.manage'] }
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(raw));
    const warnings: string[] = [];
    const s = new RolesStore(file, [], Date.now, (m) => warnings.push(m));
    await s.init();
    expect(s.role('owner')).toBeUndefined();
    expect(s.role('boss')).toBeUndefined();
    expect(s.role('helper')?.permissions).toEqual(['messages.post', 'pins.manage']);
    expect(warnings.length).toBe(3);
  });

  it('mute length is clamped to 24 h', () => {
    expect(clampMute(10 * MAX_MUTE_MS)).toBe(MAX_MUTE_MS);
    expect(clampMute(-5)).toBe(0);
  });
});
