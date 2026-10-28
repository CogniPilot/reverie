/** Read-only canonical evidence for one host-private fixed browser job.
 * This does not grant GPU access or execute a request. The host office adapter
 * binds policy/standing cue and starts only through its separately admitted port.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ChatroomService } from './chatroom-service.js';
import type { CompanyStore } from './company-store.js';
import { expertRuntimeRecipe } from './expert-runtime-recipe.js';
import { isOwnerMark } from './owner-auth/marks.js';
import { callerOf, type PolicyDeps } from './owner-auth/policy.js';
import type { SessionPort } from './web/ports/session-port.js';
import { ownerFor, resolveParentSessionId } from './web/route-helpers.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const COMMAND = '/browser-job slam-office640';
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
export const browserJobDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export interface BrowserJobEvidenceDeps {
  readonly sessions: SessionPort;
  readonly chat: ChatroomService;
  readonly company: CompanyStore;
  /** Actual current OwnerAuthService.isMessageOwner, not a client boolean. */
  readonly currentOwner: (humanId: string | undefined) => boolean;
  readonly policy: Pick<PolicyDeps, 'service' | 'ctx'>;
}

/** Register under the existing authenticated chat route class; no global policy widening. */
export function registerBrowserJobEvidence(app: FastifyInstance, deps: BrowserJobEvidenceDeps): void {
  const serverEpoch = randomUUID();
  app.get<{ Params: { id: string; messageId: string } }>('/api/chatrooms/:id/messages/:messageId/browser-job-evidence', async (req, reply) => {
    const refuse = () => reply.code(403).send({ success: false, errorCode: 'BROWSER_JOB_REFUSED', error: 'Current fixed-job source unavailable' });
    const { id, messageId } = req.params;
    if (!UUID.test(id) || !UUID.test(messageId) || callerOf(req, deps.policy).kind !== 'agent') return refuse();
    const sid = resolveParentSessionId(deps.sessions, req, undefined, ownerFor(req));
    if (!sid || req.headers['x-reverie-parent-session'] !== sid) return refuse();
    const session = deps.sessions.sessions.get(sid), state = deps.company.snapshot();
    if (new Set(state.employees.map(e => e.id)).size !== state.employees.length || new Set(state.employees.map(e => e.sessionId)).size !== state.employees.length) return refuse();
    const rows = state.employees.filter((e) => e.sessionId === sid);
    if (!session || rows.length !== 1 || state.retired.some((e) => e.sessionId === sid)) return refuse();
    const employee = rows[0]!;
    if (employee.desiredRunning !== true || employee.onVacation || employee.bindingMigration || employee.owner !== session.owner || !employee.runtimeRecipe) return refuse();
    const room = deps.chat.room(id);
    if (!room || room.archivedAt || room.kind === 'dm' || room.owner !== employee.owner || !room.members.some((m) => m.sessionId === sid)) return refuse();
    const source = room.messages.find((m) => m.id === messageId);
    if (!source || source.roomId !== id || source.deleted || source.edited || source.from.kind !== 'agent' || source.from.sessionId !== sid || source.text !== COMMAND || !source.replyTo || source.attachments?.length || source.poll || source.voice) return refuse();
    const cue = room.messages.find((m) => m.id === source.replyTo);
    if (!cue || cue.roomId !== id || cue.deleted || cue.edited || cue.from.kind !== 'user' || !isOwnerMark(cue.from.mark) || !deps.currentOwner(cue.from.humanId) || cue.at > source.at) return refuse();
    const live = expertRuntimeRecipe(session);
    // A thread/continue cursor may advance normally. Account, provider, model,
    // project and permission switches remain part of the exact selected recipe.
    const recipe = ({ runtimeThreads: _threads, ...value }: typeof live) => value;
    const liveRecipe = recipe(live), savedRecipe = recipe(employee.runtimeRecipe);
    if (browserJobDigest(liveRecipe) !== browserJobDigest(savedRecipe)) return refuse();
    return { success: true, data: {
      kind: 'CANONICAL_FIXED_BROWSER_JOB_SOURCE', version: 1, serverEpoch, jobKey: 'slam-office640',
      actor: { employeeId: employee.id, sessionId: sid, sessionGeneration: employee.sessionGeneration, owner: employee.owner ?? null, recipeSHA256: browserJobDigest(liveRecipe) },
      source: { roomId: id, messageId, at: source.at, sha256: browserJobDigest({id:source.id,roomId:source.roomId,at:source.at,from:source.from,text:source.text,replyTo:source.replyTo}), replyTo: source.replyTo },
      ownerCue: { messageId: cue.id, at: cue.at, sha256: browserJobDigest({id:cue.id,roomId:cue.roomId,at:cue.at,from:cue.from,text:cue.text}), humanId: cue.from.humanId ?? null, mark: cue.from.mark },
    } };
  });
}
