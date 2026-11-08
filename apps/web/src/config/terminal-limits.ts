/**
 * @fileoverview Terminal dimension and input validation limits.
 *
 * Used by API routes to validate resize, input, and session
 * creation requests. Separate from buffer-limits.ts which
 * controls memory buffer sizes.
 *
 * @module config/terminal-limits
 */

/** Max input length per API request (bytes) */
export const MAX_INPUT_LENGTH = 64 * 1024;

/** Max carriage returns in one teammate-pane input. Each Enter is its own tmux call (an agent CLI reads Enter
 * sent together with text as a newline, not a submit), so this bounds the synchronous calls one request makes. */
export const MAX_TEAMMATE_INPUT_ENTERS = 32;

/** Max session name length (chars) */
export const MAX_SESSION_NAME_LENGTH = 128;
