import { NO_OWNER, type OwnerVerifier, type ServiceVerifier } from '../../owner-auth/marks.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CompanyError, CompanyService } from '../../company-service.js';
import {
  CompanySettingsSchema,
  EmployeeSchema,
  EmployeePermissionsPatchSchema,
  PronounsSchema,
  SelfProfileSchema,
} from '../../company-types.js';
import type { SessionPort } from '../ports/session-port.js';
import { findSessionOrFail, ownerFor, parseBody, resolveParentSessionId } from '../route-helpers.js';
import { AvatarError, AvatarStore, MAX_AVATAR_BYTES, avatarUrl, checkAvatar } from '../../agent-avatars.js';
import { createHash } from 'node:crypto';
import { appendAdminAudit } from '../admin-audit.js';
import { adminGrant } from '../../owner-auth/policy.js';
import { ownerAvatarKey, ownerAvatarUrl } from '../../owner-avatar.js';
import { EmployeeVoiceSchema } from '../../employee-voice.js';
import type { CompanyWakeReport } from '../../company-wake.js';
import { effectiveBoardPermissions } from '../../board-permissions.js';
import { effectiveCoreBeliefs, type CompanyEmployee, type CompanySettings } from '../../company-types.js';

const HireSchema = EmployeeSchema.omit({
  id: true,
  owner: true,
  createdAt: true,
  avatar: true,
  desiredRunning: true,
  wakeAttempts: true,
  onVacation: true,
  runtimeRecipe: true,
});
const InviteSchema = z.object({ roomId: z.string().min(1).max(100) });
// Pronouns: a value sets them, null clears them (owner only, like every field here; an agent only proposes, in chat).
const UpdateSchema = EmployeeSchema.pick({ position: true, expertise: true, responsibilities: true, personality: true, coreBeliefs: true, icon: true, reportsTo: true })
  .extend({
    avatarBackground: EmployeeSchema.shape.avatarBackground.nullable(),
    pronouns: PronounsSchema.nullable(),
    sleepEnabled: EmployeeSchema.shape.sleepEnabled.removeDefault(),
    dreamEnabled: EmployeeSchema.shape.dreamEnabled.removeDefault(),
    voice: EmployeeVoiceSchema.nullable(),
    permissions: EmployeePermissionsPatchSchema,
  })
  .partial()
  .strict()
  .refine(
    (v) => Object.keys(v).length > 0,
    'Give a position, expertise, icon, avatar background, reporting parent, pronouns, voice or permissions'
  );
const RebindSchema = z.object({ sessionId: z.string().min(1).max(100) });
const ThreadSchema = z.object({ threadId: z.string().trim().min(1).max(200).nullable() });
const MemorySchema = z.object({
  text: z.string().trim().min(1).max(16000),
  kind: z.enum(['note', 'imagination']).default('note'),
});

/** Company ownership is exact: even a platform admin cannot hire into another user's company. */
export function registerCompanyRoutes(
  app: FastifyInstance,
  ctx: SessionPort,
  service: CompanyService,
  avatars?: AvatarStore,
  ownerAvatars?: AvatarStore,
  wakeEmployee?: (id: string, options?: { explicitStart?: boolean }) => Promise<CompanyWakeReport>,
  authority: {
    verifiedOwner?: OwnerVerifier;
    serviceRebind?: ServiceVerifier;
    boardCoordinator?: (sessionId: string) => boolean;
    publicationTokens?: { assertGrantIds(owner: string | undefined, ids: string[]): Promise<void> };
    /** The protected laptop-memory replacement routes are registered (server started with --resource-replacement). */
    resourceReplacement?: boolean;
  } = {}
): void {
  const verifiedOwner = authority.verifiedOwner ?? NO_OWNER;
  const presentEmployee = (employee: CompanyEmployee, includeCore = true) => {
    const effective = effectiveBoardPermissions(employee, authority.boardCoordinator?.(employee.sessionId) === true);
    const source = (key: 'editBoardIssues' | 'manageBoard' | 'manageDecisions') =>
      typeof employee.permissions[key] === 'boolean' ? 'explicit' : 'legacy';
    const projected = {
      ...employee,
      effectiveBoardPermissions: effective,
      boardPermissionSources: {
        editBoardIssues: effective.manageBoard ? 'included' : source('editBoardIssues'),
        manageBoard: source('manageBoard'),
        manageDecisions: source('manageDecisions'),
      },
    };
    if (!includeCore) {
      delete projected.coreBeliefs;
      return projected;
    }
    const companyCore = service.view(employee.owner).settings.coreBeliefs;
    return { ...projected, effectiveCoreBeliefs: effectiveCoreBeliefs(companyCore, employee.coreBeliefs) };
  };
  const validatePublicationChange = async (owner: string | undefined, before: CompanyEmployee, after: CompanyEmployee) => {
    const previous = new Set(before.permissions.publicationTokenIds ?? []);
    const added = (after.permissions.publicationTokenIds ?? []).filter(id => !previous.has(id));
    if (!added.length) return; // Revocation also works while the vault is unavailable.
    if (!authority.publicationTokens) throw new CompanyError('Publication token registry is unavailable', 503);
    try { await authority.publicationTokens.assertGrantIds(owner, added); }
    catch { throw new CompanyError('Choose available PATs belonging to this company', 400); }
  };
  const caller = (req: FastifyRequest): string | undefined =>
    req.headers['x-reverie-service-token'] !== undefined ? undefined : resolveParentSessionId(ctx, req, undefined, ownerFor(req));
  const ownerOnly = (req: FastifyRequest): void => {
    if (!verifiedOwner(req))
      throw new CompanyError('Only the company owner may configure employees or research', 403);
  };
  // The owner, or an owner-set admin agent the policy let through (owner-auth/policy.ts ADMIN_ROUTES).
  const ownerOrAdmin = (req: FastifyRequest): string => {
    const admin = adminGrant(req);
    if (admin) return `session ${admin}`;
    ownerOnly(req);
    return 'owner';
  };
  // These routes return their own envelope so they also work through app.inject().
  const run = async <T>(reply: { code(code: number): unknown }, work: () => T | Promise<T>) => {
    try {
      return { success: true, data: await work() };
    } catch (error) {
      if (!(error instanceof CompanyError)) throw error;
      reply.code(error.status);
      return { success: false, error: error.message };
    }
  };

  // Clean up the org chart: temporary-worker profiles of sessions that are gone (owner only). A live agent's record is never removed.
  app.post('/api/company/temporary/prune', async (req, reply) =>
    run(reply, async () => {
      ownerOrAdmin(req);
      const removed = await service.pruneTemporaryAgents(ownerFor(req));
      for (const id of removed) await avatars?.remove(id).catch(() => undefined);
      return { removed: removed.length };
    })
  );
  app.delete('/api/company/temporary/:sessionId', async (req, reply) =>
    run(reply, async () => {
      ownerOrAdmin(req);
      const id = (req.params as { sessionId: string }).sessionId;
      await service.removeTemporaryAgent(ownerFor(req), id);
      await avatars?.remove(id).catch(() => undefined);
      return { removed: 1 };
    })
  );

  app.get('/api/company', async (req) => {
    const view = service.view(ownerFor(req));
    return {
      success: true,
      data: { ...view, employees: view.employees.map(employee =>
        presentEmployee(employee, verifiedOwner(req) || caller(req) === employee.sessionId)), canManage: verifiedOwner(req),
        // Only the verified owner learns that laptop memory can be changed here; the routes recheck the owner themselves.
        ...(verifiedOwner(req) && authority.resourceReplacement === true ? { resourceReplacement: true } : {}) },
    };
  });
  app.post('/api/company/employees', async (req, reply) =>
    run(reply, async () => {
      ownerOnly(req);
      return { employee: await service.hire({ ...parseBody(HireSchema, req.body), owner: ownerFor(req) }) };
    })
  );
  app.put('/api/company/settings', async (req, reply) =>
    run(reply, async () => {
      ownerOnly(req);
      // Parse only supplied keys: applying schema defaults before merging would
      // reset unrelated recovery, scheduling or core settings on a partial edit.
      const patch = parseBody(z.record(z.string(), z.unknown()), req.body);
      if (Object.keys(patch).some(key => !Object.hasOwn(CompanySettingsSchema.shape, key)))
        throw new CompanyError('Unknown company setting', 400);
      return { settings: await service.configure(ownerFor(req), patch as Partial<Omit<CompanySettings, 'owner'>>) };
    })
  );
  app.post('/api/company/employees/:id/wake', async (req, reply) =>
    run(reply, async () => {
      const owner = ownerFor(req);
      const view = service.view(owner);
      const self = caller(req);
      if (
        !verifiedOwner(req) &&
        (!self || !view.employees.some((e) => e.sessionId === self && e.permissions.recoverEmployees))
      )
        throw new CompanyError('Only the owner or an employee granted recovery permission may wake an employee', 403);
      const { id } = req.params as { id: string };
      const employee = view.employees.find((e) => e.id === id);
      if (!employee) throw new CompanyError('Unknown company employee', 404);
      if (employee.onVacation) throw new CompanyError('Return the employee from vacation before waking them', 409);
      if (!wakeEmployee) throw new CompanyError('Recovery is not ready', 503);
      const result = await wakeEmployee(id);
      void appendAdminAudit({
        admin: self ? 'session ' + self : 'owner',
        action: 'employee_wake',
        target: employee.name,
        ip: req.ip,
        detail: { id, by: self },
      });
      return { recovery: result };
    })
  );
  app.put('/api/company/employees/:id/session', async (req, reply) =>
    run(reply, async () => {
      const { id } = req.params as { id: string };
      const { sessionId } = parseBody(RebindSchema, req.body);
      if (verifiedOwner(req) || authority.serviceRebind?.(req)) {
        await appendAdminAudit({ admin: verifiedOwner(req) ? 'owner' : 'service:watcher', action: 'employee_rebind_requested', target: id, ip: req.ip, detail: { id, sessionId } });
        return { employee: await service.rebind(id, ownerFor(req), sessionId) };
      }
      // An agent needs the owner's explicit recovery grant, checked by the service and audited.
      const self = caller(req);
      if (!self)
        throw new CompanyError(
          'Only the owner or an employee granted recovery permission may recover an employee session',
          403
        );
      const employee = await service.recover(id, ownerFor(req), self, sessionId);
      void appendAdminAudit({
        admin: `session ${self}`,
        action: 'employee_recover',
        target: employee.name,
        ip: req.ip,
        detail: { id, by: self, sessionId },
      });
      return { employee };
    })
  );
  app.put('/api/company/employees/:id/thread', async (req, reply) =>
    run(reply, async () => {
      ownerOnly(req);
      const { id } = req.params as { id: string };
      return { employee: await service.setThread(id, ownerFor(req), parseBody(ThreadSchema, req.body).threadId) };
    })
  );
  app.put('/api/company/employees/:id', async (req, reply) =>
    run(reply, async () => {
      ownerOnly(req);
      const { id } = req.params as { id: string };
      const change = parseBody(UpdateSchema, req.body);
      const employee = await service.update(id, ownerFor(req), change, async (before, after) => {
        await validatePublicationChange(ownerFor(req), before, after);
        await appendAdminAudit({
          admin: 'owner',
          action: 'employee_update',
          target: after.name,
          ip: req.ip,
          detail: {
            id,
            fields: Object.keys(change),
            position: { from: before.position, to: after.position },
            permissions: { from: before.permissions, to: after.permissions },
            reportsTo: { from: before.reportsTo ?? null, to: after.reportsTo ?? null },
            ...(before.avatarBackground !== after.avatarBackground
              ? { avatarBackground: { from: before.avatarBackground ?? null, to: after.avatarBackground ?? null } }
              : {}),
            ...(before.pronouns !== after.pronouns
              ? { pronouns: { from: before.pronouns ?? null, to: after.pronouns ?? null } }
              : {}),
            ...(JSON.stringify(before.voice) !== JSON.stringify(after.voice)
              ? { voice: { from: before.voice ?? null, to: after.voice ?? null } }
              : {}),
          },
        });
      });
      return { employee: presentEmployee(employee) };
    })
  );
  app.put<{ Params: { id: string; tokenId: string } }>('/api/company/employees/:id/publication-tokens/:tokenId', async (req, reply) =>
    run(reply, async () => {
      ownerOnly(req);
      const { id, tokenId } = req.params;
      const { enabled } = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body);
      if (!z.string().uuid().safeParse(tokenId).success) throw new CompanyError('Choose a valid PAT identifier', 400);
      const employee = await service.setPublicationTokenGrant(id, ownerFor(req), tokenId, enabled, async (before, after) => {
        await validatePublicationChange(ownerFor(req), before, after);
        await appendAdminAudit({ admin: 'owner', action: 'employee_update', target: after.name, ip: req.ip,
          detail: { id, fields: ['permissions'], permissions: { from: before.permissions, to: after.permissions } } });
      });
      return { employee: presentEmployee(employee) };
    })
  );
  // Retire an employee whose session is gone, or put a retired one back (owner only; refused with any agent header).
  app.post('/api/company/employees/:id/vacation', async (req, reply) =>
    run(reply, async () => {
      ownerOnly(req);
      const { id } = req.params as { id: string };
      const { enabled } = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body);
      if (!enabled && !wakeEmployee) throw new CompanyError('Employee startup is not ready', 503);
      const employee = await service.setVacation(id, ownerFor(req), enabled);
      if (enabled) return { employee };
      let recovery: CompanyWakeReport;
      try {
        recovery = await wakeEmployee!(id, { explicitStart: true });
      } catch {
        return { employee, startup: { state: 'blocked' as const, reason: 'wake-failed' } };
      }
      // Persisted intent and an actual successful start are distinct. Return a
      // launch refusal so the UI cannot claim that a disconnected expert started.
      const reason = recovery.skipped.find((entry) => entry.employeeId === id)?.reason;
      const startup = recovery.awakened.includes(id)
        ? { state: 'started' as const }
        : reason
          ? { state: 'blocked' as const, reason }
          : { state: 'already-running' as const };
      return { employee, startup };
    })
  );
  app.post('/api/company/employees/:id/retire', async (req, reply) =>
    run(reply, async () => {
      ownerOnly(req);
      const { id } = req.params as { id: string };
      const { employee, rooms, failed } = await service.retire(id, ownerFor(req));
      void appendAdminAudit({
        admin: 'owner',
        action: 'employee_retire',
        target: employee.name,
        ip: req.ip,
        detail: { id, sessionId: employee.sessionId, rooms, failed },
      });
      return { employee, rooms, failed };
    })
  );
  app.post('/api/company/employees/:id/restore', async (req, reply) =>
    run(reply, async () => {
      const by = ownerOrAdmin(req);
      const { id } = req.params as { id: string };
      const employee = await service.restore(id, ownerFor(req));
      void appendAdminAudit({
        admin: by,
        action: 'employee_restore',
        target: employee.name,
        ip: req.ip,
        detail: { id, sessionId: employee.sessionId },
      });
      return { employee };
    })
  );
  // An agent edits its OWN display name and icon; there is no target in the path, so it can name no
  // one else. "Own" is the session X-Reverie-Parent-Session resolves to within the owner's scope:
  // a hint local agent tooling sets, not authentication. No header, or one that does not resolve,
  // is refused; the owner edits employees through the routes above.
  app.post('/api/company/self', async (req, reply) =>
    run(reply, async () => {
      const self = caller(req);
      if (!self) throw new CompanyError('Only an agent session edits its own profile', 403);
      return { profile: await service.updateSelf(self, ownerFor(req), parseBody(SelfProfileSchema, req.body)) };
    })
  );
  app.post('/api/company/employees/:id/invite', async (req, reply) =>
    run(reply, () => {
      const self = caller(req);
      if (!verifiedOwner(req) && !self)
        throw new CompanyError('Unknown agent session', 403);
      const { id } = req.params as { id: string };
      return { employee: service.invite(id, parseBody(InviteSchema, req.body).roomId, ownerFor(req), self) };
    })
  );
  app.post('/api/company/employees/:id/memories', async (req, reply) =>
    run(reply, async () => {
      ownerOnly(req);
      const { id } = req.params as { id: string };
      const body = parseBody(MemorySchema, req.body);
      return { memory: await service.remember(id, ownerFor(req), body.text, body.kind) };
    })
  );

  // The owner's own picture: owner only to set or clear (a request naming an agent session is refused); the link is kept in the
  // company settings the page already loads, and the image is served with a versioned immutable cache plus an ETag.
  if (ownerAvatars) {
    const key = (req: FastifyRequest): string => ownerAvatarKey(ownerFor(req));
    const ownerImage = async <T>(reply: { code(code: number): unknown }, work: () => Promise<T>) => {
      try {
        return await run(reply, work);
      } catch (error) {
        if (!(error instanceof AvatarError)) throw error;
        reply.code(error.status);
        return { success: false, error: error.message };
      }
    };
    void app.register(async (scope) => {
      scope.addContentTypeParser(
        ['application/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'],
        { parseAs: 'buffer', bodyLimit: MAX_AVATAR_BYTES + 1024 },
        (_req, body, done) => done(null, body)
      );
      scope.post('/api/company/owner/avatar', async (req, reply) =>
        ownerImage(reply, async () => {
          ownerOnly(req);
          checkAvatar(req.body);
          const previous = await ownerAvatars.get(key(req));
          await ownerAvatars.put(key(req), req.body as Buffer);
          try {
            return {
              settings: await service.setOwnerAvatar(
                ownerFor(req),
                ownerAvatarUrl(ownerFor(req), await service.nextOwnerAvatarVersion(ownerFor(req)))
              ),
            };
          } catch (error) {
            if (previous) await ownerAvatars.put(key(req), previous.data);
            else await ownerAvatars.remove(key(req));
            throw error;
          }
        })
      );
    });
    app.delete('/api/company/owner/avatar', async (req, reply) =>
      ownerImage(reply, async () => {
        ownerOnly(req);
        const settings = await service.setOwnerAvatar(ownerFor(req), null);
        await ownerAvatars.remove(key(req));
        return { settings };
      })
    );
    app.get('/api/owner-avatar/:key', async (req, reply) => {
      const stored = (req.params as { key: string }).key === key(req) ? await ownerAvatars.get(key(req)) : undefined;
      if (!stored) return reply.code(404).send({ success: false, error: 'No profile picture' });
      const etag = `"${createHash('sha256').update(stored.data).digest('hex').slice(0, 32)}"`;
      reply
        .header('ETag', etag)
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox");
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.header('Content-Type', stored.type).send(stored.data);
    });
  }

  if (!avatars) return;
  // Profile images. An agent sets or clears its OWN (the caller rule of /api/company/self); the
  // verified owner
  // may set any agent's. The image is checked by its bytes before anything is recorded or stored.
  // The file is written BEFORE its URL is recorded, so a failed write never leaves a link to nothing;
  // if recording then fails (unknown session, profile cap), the previous image is put back.
  const setAvatar = async (req: FastifyRequest, sessionId: string, data: unknown) => {
    checkAvatar(data);
    const previous = await avatars.get(sessionId);
    await avatars.put(sessionId, data as Buffer);
    try {
      return { profile: await service.setAvatar(sessionId, ownerFor(req), avatarUrl(sessionId, Date.now()), verifiedOwner(req)) };
    } catch (error) {
      if (previous) await avatars.put(sessionId, previous.data);
      else await avatars.remove(sessionId);
      throw error;
    }
  };
  const clearAvatar = async (req: FastifyRequest, sessionId: string) => {
    const result = await service.setAvatar(sessionId, ownerFor(req), null, verifiedOwner(req));
    await avatars.remove(sessionId);
    return { profile: result };
  };
  const self = (req: FastifyRequest): string => {
    const id = caller(req);
    if (!id) throw new CompanyError('Only an agent session edits its own profile', 403);
    return id;
  };
  const avatarTarget = (req: FastifyRequest): string => {
    const { sessionId } = req.params as { sessionId: string };
    const state = service.store.snapshot();
    const employees = [...state.employees, ...state.retired].filter((e) => e.sessionId === sessionId);
    if (employees.length) {
      const owner = ownerFor(req);
      const session = ctx.sessions.get(sessionId);
      if (employees.some((e) => e.owner !== owner) || (session && session.owner !== owner))
        throw Object.assign(new CompanyError('Unknown employee', 404), { statusCode: 404 });
      return sessionId;
    }
    return findSessionOrFail(ctx, sessionId, req).id;
  };
  const agentByOwner = (req: FastifyRequest): string => {
    ownerOnly(req);
    return avatarTarget(req);
  };
  const image = async <T>(reply: { code(code: number): unknown }, work: () => Promise<T>) => {
    try {
      return await run(reply, work);
    } catch (error) {
      if (!(error instanceof AvatarError)) throw error;
      reply.code(error.status);
      return { success: false, error: error.message };
    }
  };
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      ['application/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      { parseAs: 'buffer', bodyLimit: MAX_AVATAR_BYTES + 1024 },
      (_req, body, done) => done(null, body)
    );
    scope.post('/api/company/self/avatar', async (req, reply) =>
      image(reply, () => setAvatar(req, self(req), req.body))
    );
    scope.post('/api/company/agents/:sessionId/avatar', async (req, reply) =>
      image(reply, () => setAvatar(req, agentByOwner(req), req.body))
    );
  });
  app.delete('/api/company/self/avatar', async (req, reply) => image(reply, () => clearAvatar(req, self(req))));
  app.delete('/api/company/agents/:sessionId/avatar', async (req, reply) =>
    image(reply, () => clearAvatar(req, agentByOwner(req)))
  );
  app.get('/api/avatars/:sessionId', async (req, reply) => {
    const stored = await avatars.get(avatarTarget(req));
    if (!stored) return reply.code(404).send({ success: false, error: 'No profile image' });
    return reply
      .header('Content-Type', stored.type)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=86400')
      .send(stored.data);
  });
}
