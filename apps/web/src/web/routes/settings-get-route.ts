/**
 * GET /api/settings, served by TS or, when the owner moved it, by the Rust handler. Both answer from
 * the same file and the same envelope; only one of them serves a given server.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OwnerVerifier } from '../../owner-auth/marks.js';
import type { RouteChannel } from '../../rust-routes/channel.js';
import { SETTINGS } from '../../rust-routes/frames.js';
import { publishOutcome } from '../../rust-routes/publish.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { readJsonConfig } from '../route-helpers.js';

export interface SettingsGetDeps {
  /** The exact path TS reads; it may be relative to this process's working directory. */
  settingsPath: string;
  verifiedOwner: OwnerVerifier;
  rust?: RouteChannel;
}

export function registerSettingsGet(app: FastifyInstance, deps: SettingsGetDeps): void {
  app.get('/api/settings', async (req, reply) => {
    if (deps.rust) return forwardSettings(deps.rust, deps, req, reply);
    // A plain read. This route must NEVER write settings.json: readJsonConfig()
    // answers `{}` for ANY read failure (a parse error, EACCES, EMFILE, a read
    // that lands inside PUT's non-atomic write), not only for a missing file,
    // and every page load calls this route, so a "persist the default when the
    // key is absent" reconcile here replaced a whole settings file with one key
    // on the first unlucky read. The plan-usage default is resolved by the
    // READERS instead: an absent `showPlanUsageLimits` means ON to
    // readPlanUsageTelemetryEnabled() (hooks-config.ts), the same way an absent
    // `workspaceHooksEnabled` means ON, and the client resolves its own display
    // default through planUsageChipEnabled(). Pinned by
    // test/routes/system-routes-settings-get-plan-usage-default.test.ts.
    return readJsonConfig(deps.settingsPath, 'settings', {});
  });
}

/**
 * The moved GET. The global hooks already admitted the request; this route has no check of its own,
 * so the only authorization to re-check is an owner session that admitted it and has since ended.
 * The Rust handler sends the final envelope bytes and their media, so no hook rewraps them.
 */
async function forwardSettings(
  channel: RouteChannel,
  deps: SettingsGetDeps,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const owner = deps.verifiedOwner(req);
  const ticket = channel.admit(SETTINGS, Buffer.from(JSON.stringify({ settingsPath: deps.settingsPath })));
  const gone = () => {
    if (!reply.raw.writableFinished) ticket.abandon();
  };
  reply.raw.once('close', gone);
  try {
    const step = await ticket.next();
    if (step.kind !== 'done') throw new Error('the Rust settings handler asked for an observation');
    return publishOutcome(
      channel,
      step.outcome,
      req,
      reply,
      () => !owner || deps.verifiedOwner(req),
      () => createErrorResponse(ApiErrorCode.FORBIDDEN, 'The owner session ended while settings were read')
    );
  } catch (error) {
    ticket.abandon();
    throw error;
  } finally {
    reply.raw.removeListener('close', gone);
  }
}
