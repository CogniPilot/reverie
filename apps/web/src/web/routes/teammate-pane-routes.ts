/**
 * @fileoverview A teammate's own tmux pane, for the teammate terminal window: read its buffer and
 * type into it. Only a pane that the session's agent team lists for a teammate (never the lead's,
 * never an in-process teammate) is reachable, so these routes cannot open any other pane.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InfraPort, SessionPort } from '../ports/index.js';
import { findSessionOrFail, parseBody } from '../route-helpers.js';
import { ApiErrorCode, createErrorResponse } from '../../types/api.js';
import { MAX_INPUT_LENGTH, MAX_TEAMMATE_INPUT_ENTERS } from '../../config/terminal-limits.js';

/** A tmux pane id as agent teams record it (`%12`). */
const PANE_TARGET = /^%\d{1,9}$/;

const TeammatePaneInputSchema = z
  .object({
    paneTarget: z.string().regex(PANE_TARGET),
    // Each Enter is its own synchronous tmux call, so their number is bounded before anything is sent.
    input: z
      .string()
      .min(1)
      .max(MAX_INPUT_LENGTH)
      .refine((input) => (input.match(/\r/g)?.length ?? 0) <= MAX_TEAMMATE_INPUT_ENTERS, {
        message: `At most ${MAX_TEAMMATE_INPUT_ENTERS} line breaks at once`,
      }),
  })
  .strict();

/** Whether `paneTarget` is a teammate pane of the team that `sessionId` leads. */
function isTeammatePane(ctx: InfraPort, sessionId: string, paneTarget: string): boolean {
  const team = ctx.teamWatcher.getTeamForSession(sessionId);
  return !!team?.members.some(
    (m) => m.agentType !== 'team-lead' && m.tmuxPaneId === paneTarget && m.tmuxPaneId !== 'in-process'
  );
}

export function registerTeammatePaneRoutes(app: FastifyInstance, ctx: SessionPort & InfraPort): void {
  app.get('/api/sessions/:id/teammate-pane-buffer/:paneTarget', async (req) => {
    const { id, paneTarget } = req.params as { id: string; paneTarget: string };
    const session = findSessionOrFail(ctx, id, req);
    if (!PANE_TARGET.test(paneTarget) || !isTeammatePane(ctx, session.id, paneTarget)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Not a teammate pane of this session');
    }
    const muxName = session.muxName;
    const buffer = muxName ? (ctx.mux.capturePaneBuffer?.(muxName, paneTarget) ?? null) : null;
    if (buffer === null) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Teammate pane could not be read');
    return { success: true, data: { buffer } };
  });

  app.post('/api/sessions/:id/teammate-pane-input', async (req) => {
    const { id } = req.params as { id: string };
    const { paneTarget, input } = parseBody(TeammatePaneInputSchema, req.body);
    const session = findSessionOrFail(ctx, id, req);
    if (!isTeammatePane(ctx, session.id, paneTarget)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Not a teammate pane of this session');
    }
    const muxName = session.muxName;
    if (!muxName || !ctx.mux.sendInputToPane?.(muxName, paneTarget, input)) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Input did not reach the teammate pane');
    }
    return { success: true };
  });
}
