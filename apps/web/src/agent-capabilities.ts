/** Caller-specific facts, produced by the same Board caller/lead gates as writes. */
export interface AgentCapabilities {
  checkedAt: number;
  identity: { kind: 'owner' | 'agent'; sessionId?: string; employeeId?: string; name: string };
  board: {
    read: boolean;
    fileIssue: boolean;
    /** Optional for compatibility with older capability endpoints. */
    editBoardIssues?: boolean;
    manageDecisions?: boolean;
    createDecision: boolean;
    manageBoard: boolean;
    clearDecision: boolean;
    reason: string;
  };
  company: { manageOffice?: boolean; recoverEmployees: boolean; moveOwnPlan: boolean; managePlans: boolean; planPreconditions: string };
}
