import type { ChatRoom } from './chatroom-store.js';
import { ownerMade } from './owner-auth/relations.js';

/** The existing active owner-made membership relation, never an employee title. */
export function isBoardCoordinator(rooms: readonly ChatRoom[], sessionId: string): boolean {
  return rooms.some(room => !room.archivedAt && room.members.some(member =>
    member.sessionId === sessionId && member.role === 'coordinator' && ownerMade(member)));
}

/** Owner-selected Board grants. Absence retains the existing owner-made membership policy. */
export interface BoardPermissionFlags {
  editBoardIssues?: boolean;
  manageBoard?: boolean;
  manageDecisions?: boolean;
}

export interface EffectiveBoardPermissions {
  editBoardIssues: boolean;
  manageBoard: boolean;
  manageDecisions: boolean;
}

export function effectiveBoardPermissions(
  employee: { permissions?: BoardPermissionFlags } | undefined,
  ownerMadeCoordinator: boolean
): EffectiveBoardPermissions {
  if (!employee) return { editBoardIssues: false, manageBoard: false, manageDecisions: false };
  const permissions = employee.permissions;
  const manageBoard = permissions?.manageBoard ?? ownerMadeCoordinator;
  const manageDecisions = permissions?.manageDecisions ?? ownerMadeCoordinator;
  return {
    editBoardIssues: manageBoard || (permissions?.editBoardIssues ?? true),
    manageBoard,
    manageDecisions,
  };
}
