/** Exit codes shared by the main agent CLI and its independently installable add-on. */
export const AGENT_EXIT = { ok: 0, error: 1, timeout: 2, dead: 3, refused: 4 } as const;
