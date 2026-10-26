import { describe, expect, it } from 'vitest';
import { EmployeePermissionsSchema } from '../src/company-types.js';
import { effectiveBoardPermissions, isBoardCoordinator } from '../src/board-permissions.js';
import type { ChatRoom } from '../src/chatroom-store.js';

describe('explicit Board grants and legacy compatibility', () => {
  it('preserves absent grant fields instead of inserting an override', () => {
    const legacy = EmployeePermissionsSchema.parse({});
    expect(legacy).not.toHaveProperty('editBoardIssues');
    expect(legacy).not.toHaveProperty('manageBoard');
    expect(legacy).not.toHaveProperty('manageDecisions');
    expect(effectiveBoardPermissions({ permissions: legacy }, false)).toEqual({ editBoardIssues: true, manageBoard: false, manageDecisions: false });
    expect(effectiveBoardPermissions({ permissions: legacy }, true)).toEqual({ editBoardIssues: true, manageBoard: true, manageDecisions: true });
  });
  it('explicit false revokes coordinator grants, while board management includes basic work', () => {
    expect(effectiveBoardPermissions({ permissions: { editBoardIssues: false, manageBoard: false, manageDecisions: false } }, true))
      .toEqual({ editBoardIssues: false, manageBoard: false, manageDecisions: false });
    expect(effectiveBoardPermissions({ permissions: { editBoardIssues: false, manageBoard: true, manageDecisions: false } }, false))
      .toEqual({ editBoardIssues: true, manageBoard: true, manageDecisions: false });
    expect(effectiveBoardPermissions({ permissions: { editBoardIssues: false, manageBoard: false, manageDecisions: true } }, false))
      .toEqual({ editBoardIssues: false, manageBoard: false, manageDecisions: true });
    expect(effectiveBoardPermissions(undefined, true)).toEqual({ editBoardIssues: false, manageBoard: false, manageDecisions: false });
    expect(EmployeePermissionsSchema.safeParse({ manageBoard: 'true' }).success).toBe(false);
  });
  it('uses only active owner-made coordinator membership, never a title or agent-made relation', () => {
    const rooms = [{ members: [{ sessionId: 's', role: 'coordinator' }] }] as ChatRoom[];
    expect(isBoardCoordinator(rooms, 's')).toBe(true);
    rooms[0]!.archivedAt = 1;
    expect(isBoardCoordinator(rooms, 's')).toBe(false);
    delete rooms[0]!.archivedAt;
    rooms[0]!.members[0]!.addedBy = 'another-agent';
    expect(isBoardCoordinator(rooms, 's')).toBe(false);
    expect(isBoardCoordinator(rooms, 'other')).toBe(false);
  });
});
