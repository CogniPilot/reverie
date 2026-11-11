/**
 * @fileoverview Expert templates: owner instance data describing a specialist the owner (or a
 * delegate the owner names) can hire as a company employee with its own session.
 *
 * The record lives in `experts.json` next to the other instance data, written whole (temp file,
 * fsync, rename, mode 0600). It is never part of the repository. When the file does not exist yet,
 * the first read seeds it from the JSON files in an optional seed directory.
 *
 * A template is a launch spec only: name, icon, role, persona, expertise, kind, launch defaults and
 * rooms. It has no data directory (the runtime always assigns one), no initial self-model and no
 * directive list, so a template can neither set nor remove the runtime's fixed defaults and
 * safeguards. Text that looks like a credential is refused, and the matched text is never echoed.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { normalizeIcon } from './chatroom-store.js';
import { writeCompanyStateFile } from './company-store.js';
import { getCli } from './config/cli-registry/registry.js';

export const EXPERT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_EXPERT_TEMPLATES = 100;
/** Hire records are kept (never trimmed); past this many, a new hire is refused. */
export const MAX_HIRE_RECORDS = 5000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export class ExpertError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

/** Patterns of common secrets. A hit refuses the whole value; the text itself is never reported. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pa[t]_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /[A-Za-z0-9_-]{40,}/,
  /:\/\/[^\s/@:]+:[^\s/@]+@/,
];

export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((p) => p.test(text));
}

/** The dotted path of the first string inside `value` that looks like a credential, if any. */
export function findCredential(value: unknown, path = ''): string | undefined {
  if (typeof value === 'string') return looksLikeCredential(value) ? path || 'value' : undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findCredential(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      const hit = findCredential(inner, path ? `${path}.${key}` : key);
      if (hit) return hit;
    }
  }
  return undefined;
}

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\p{Cc}\u2028\u2029]/u.test(s), 'Use one line of text');

export const ModelIdSchema = z
  .string()
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._\-[\]/:]*$/, 'Invalid model id');
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
export const AccountProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Invalid account profile id');
export const CliModeSchema = z
  .string()
  .min(1)
  .max(24)
  .refine((mode) => !!getCli(mode), 'Unknown CLI mode');

/** What the owner sends for a template (the id is the path). Unknown keys are refused, not ignored. */
export const ExpertTemplateBodySchema = z
  .object({
    id: z.string().optional(),
    name: oneLine(40),
    icon: z
      .string()
      .refine((s) => !!normalizeIcon(s), 'An icon is one emoji or at most two characters')
      .transform((s) => normalizeIcon(s)!),
    role: oneLine(80),
    persona: z.string().trim().min(1).max(4000),
    expertise: z.array(oneLine(60)).max(12).default([]),
    kind: z.enum(['expert', 'implementer']).default('expert'),
    defaults: z
      .object({
        mode: CliModeSchema,
        model: ModelIdSchema.optional(),
        effort: EffortSchema.optional(),
        accountProfileId: AccountProfileIdSchema.optional(),
      })
      .strict(),
    rooms: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  })
  .strict();

export const ExpertTemplateSchema = ExpertTemplateBodySchema.omit({ id: true }).extend({
  id: z.string().regex(EXPERT_ID_PATTERN),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ExpertTemplate = z.infer<typeof ExpertTemplateSchema>;

export const ExpertSettingsSchema = z
  .object({
    /** Session ids (owner-managed) that may hire and retire on the owner's behalf. */
    hireDelegates: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    /** Employee identities; authorization follows only their current session. */
    hireEmployeeDelegates: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    /** Hires in any rolling 24 hours, across every caller. */
    maxHiresPerDay: z.number().int().min(0).max(20).default(2),
    /** Hires not yet retired. */
    maxActive: z.number().int().min(0).max(50).default(5),
    /** The room each hire and retirement is announced in. */
    noticeRoomId: z.string().trim().min(1).max(100).optional(),
    /** A delegate's hire must carry a budget stop. */
    requireBudgetStopForDelegates: z.boolean().default(false),
    /** The only directory (or below it) a delegate may give as `workingDir`; unset refuses delegate hires. */
    delegateWorkingRoot: z
      .string()
      .min(1)
      .max(4096)
      .refine((p) => p.startsWith('/'), 'delegateWorkingRoot is an absolute path')
      .optional(),
    /** Minutes between the budget-stop checkpoint request and the retirement. */
    budgetStopGraceMinutes: z.number().int().min(1).max(120).default(10),
  })
  .strict()
  .refine(
    (settings) => settings.hireDelegates.length + settings.hireEmployeeDelegates.length <= 20,
    'Choose at most 20 hiring delegates across employee and legacy session permissions'
  );
export type ExpertSettings = z.infer<typeof ExpertSettingsSchema>;

/** What a hire body sets: stop the hire once this plan's weekly usage reaches `weeklyPercent`. */
export const BudgetStopBodySchema = z
  .object({
    planId: z.string().trim().min(1).max(200),
    weeklyPercent: z.number().min(1).max(100),
  })
  .strict();

export const BudgetStopSchema = BudgetStopBodySchema.extend({
  /** When the stop fired (the checkpoint request was sent); the retirement follows after the grace. */
  triggeredAt: z.number().optional(),
  /** The last "cannot be checked" notice, so it is posted at most once a day per hire. */
  uncheckedNoticeAt: z.number().optional(),
  /** The last "could not retire" notice, so it is posted at most once an hour per hire. */
  retireFailNoticeAt: z.number().optional(),
});
export type BudgetStop = z.infer<typeof BudgetStopSchema>;

/** Launch return is a dispatch acknowledgement, never proof of readiness or current presence. */
export const ExpertStartupSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('legacy') }).strict(),
  z.object({ phase: z.literal('prepared'), sessionGeneration: z.number().int().positive() }).strict(),
  z.object({ phase: z.literal('issued'), sessionGeneration: z.number().int().positive() }).strict(),
  z.object({ phase: z.literal('launch-returned'), sessionGeneration: z.number().int().positive() }).strict(),
  z.object({ phase: z.literal('recovery-required'), sessionGeneration: z.number().int().positive() }).strict(),
  z.object({ phase: z.literal('not-issued'), sessionGeneration: z.number().int().positive() }).strict(),
]);
const LegacyExpertHireSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  sessionId: z.string(),
  employeeId: z.string(),
  /** Canonical company scope at hire time. Missing legacy values stay unscoped. */
  owner: z.string().optional(),
  /** 'owner' or 'agent:<session id>'. */
  by: z.string(),
  reason: z.string(),
  hiredAt: z.number(),
  status: z.enum(['active', 'retired']),
  retiredAt: z.number().optional(),
  retiredBy: z.string().optional(),
  retireReason: z.string().optional(),
  budgetStop: BudgetStopSchema.optional(),
  /** Set when the owner hired by approving a delegate's request. */
  requestId: z.string().optional(),
});
export const ExpertHireSchema = LegacyExpertHireSchema.extend({
  startup: ExpertStartupSchema,
  notice: z.enum(['unconfirmed', 'posted']).optional(),
  audit: z.enum(['unconfirmed', 'recorded']).optional(),
})
  .strict()
  .superRefine((hire, context) => {
    if (hire.startup.phase === 'legacy') return;
    for (const field of ['id', 'employeeId', 'sessionId'] as const)
      if (!hire[field].trim())
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'A retained startup requires its exact non-empty identity',
        });
  });
export type ExpertHire = z.infer<typeof ExpertHireSchema>;

/** The binding a hire request holds on its template: every field, so a same-millisecond edit is a different template. */
export function templateDigest(template: ExpertTemplate): string {
  return createHash('sha256').update(JSON.stringify(template)).digest('hex');
}

export const MAX_HIRE_REQUESTS = 500;
/** Open requests one delegate may have waiting at once. */
export const MAX_PENDING_HIRE_REQUESTS = 5;

/**
 * What a delegate asks the owner to hire: the hire body (as the owner would send it, harness and account included)
 * plus optional identity overrides. Nothing in it takes effect until the owner approves it.
 */
export const HireRequestFieldsSchema = z.object({
  workingDir: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'workingDir is an absolute path'),
  mode: CliModeSchema.optional(),
  model: ModelIdSchema.optional(),
  effort: EffortSchema.optional(),
  accountProfileId: AccountProfileIdSchema.optional(),
  reason: z.string().trim().min(3).max(500),
  budgetStop: BudgetStopBodySchema.optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((s) => !/[\p{Cc}\u2028\u2029]/u.test(s), 'A name is one line of text')
    .optional(),
  position: z.string().trim().min(1).max(100).optional(),
  reportsTo: z.string().trim().min(1).max(100).optional(),
  rooms: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
});
export type HireRequestFields = z.infer<typeof HireRequestFieldsSchema>;

export const HireReservationSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('creation-issued'), at: z.number().finite() }).strict(),
  z
    .object({
      phase: z.literal('session-bound'),
      at: z.number().finite(),
      sessionId: z
        .string()
        .min(1)
        .refine((id) => !!id.trim()),
    })
    .strict(),
]);
export const ExpertHireRequestSchema = z.object({
  id: z.string(),
  /** Canonical owner at request time; missing legacy scope remains unscoped. */
  owner: z.string().optional(),
  templateId: z.string(),
  /** sha256 of the whole template as it stood at the request; the hire refuses any other template, at every step. */
  templateSha256: z.string().regex(/^[0-9a-f]{64}$/),
  fields: HireRequestFieldsSchema,
  /** 'agent:<session id>'. */
  requestedBy: z.string(),
  requestedAt: z.number(),
  /** `approving` is held while the owner's hire runs, so a second approval cannot start another. */
  status: z.enum(['pending', 'approving', 'approved', 'declined', 'withdrawn']),
  decidedAt: z.number().optional(),
  decidedBy: z.string().optional(),
  note: z.string().optional(),
  hireId: z.string().optional(),
  /** A creation attempt may have no returned SID. Only session-bound carries the genuine returned SID. */
  reservation: HireReservationSchema.optional(),
});
export type ExpertHireRequest = z.infer<typeof ExpertHireRequestSchema>;

/** v1 is read for migration only; v2's literal version fences the previous v1 reader. */
export const LegacyExpertStateSchema = z.object({
  version: z.literal(1),
  templates: z.array(ExpertTemplateSchema),
  settings: ExpertSettingsSchema,
  hires: z.array(LegacyExpertHireSchema),
  hireRequests: z.array(ExpertHireRequestSchema).default([]),
});
export const ExpertStateSchema = LegacyExpertStateSchema.extend({
  version: z.literal(2),
  hires: z.array(ExpertHireSchema),
}).strict();
export type ExpertState = z.infer<typeof ExpertStateSchema>;

/** An approval with an unresolved canonical-creation result keeps a capacity reservation across restarts. */
export function expertHireUsage(
  state: ExpertState,
  at: number,
  excludeHireId?: string,
  excludeRequestId?: string
): { recent: number; active: number } {
  const reserved = state.hireRequests.filter(
    (request) =>
      request.id !== excludeRequestId &&
      request.status === 'approving' &&
      request.reservation &&
      !state.hires.some((hire) => hire.id === request.hireId || hire.requestId === request.id)
  );
  return {
    recent:
      state.hires.filter((hire) => hire.id !== excludeHireId && hire.hiredAt > at - DAY_MS).length +
      reserved.filter((request) => request.reservation!.at > at - DAY_MS).length,
    active:
      state.hires.filter((hire) => hire.id !== excludeHireId && hire.status === 'active').length + reserved.length,
  };
}

/** One-way startup journal. Employment retirement never supplies launch or readiness evidence. */
function validateHireTransitions(previous: ExpertState, next: ExpertState): void {
  const allowed: Record<ExpertHire['startup']['phase'], readonly ExpertHire['startup']['phase'][]> = {
    legacy: ['legacy'],
    prepared: ['prepared', 'issued', 'not-issued'],
    issued: ['issued', 'launch-returned', 'recovery-required'],
    'launch-returned': ['launch-returned'],
    'recovery-required': ['recovery-required'],
    'not-issued': ['not-issued'],
  };
  const ids = new Set<string>();
  for (const hire of next.hires) {
    if (ids.has(hire.id)) throw new ExpertError('Duplicate hire operation', 409);
    ids.add(hire.id);
    const old = previous.hires.find((row) => row.id === hire.id);
    if (!old) {
      if (!['prepared', 'not-issued'].includes(hire.startup.phase))
        throw new ExpertError('A hire must begin before launch dispatch', 409);
      continue;
    }
    if (
      (old.status === 'retired' && hire.status !== 'retired') ||
      old.employeeId !== hire.employeeId ||
      old.sessionId !== hire.sessionId ||
      old.owner !== hire.owner ||
      old.requestId !== hire.requestId ||
      old.templateId !== hire.templateId ||
      old.by !== hire.by ||
      old.hiredAt !== hire.hiredAt ||
      old.reason !== hire.reason ||
      !allowed[old.startup.phase].includes(hire.startup.phase) ||
      (old.startup.phase !== 'legacy' &&
        (hire.startup.phase === 'legacy' || old.startup.sessionGeneration !== hire.startup.sessionGeneration))
    )
      throw new ExpertError('Invalid retained hire startup transition or binding change', 409);
  }
  if (previous.hires.some((hire) => !ids.has(hire.id)))
    throw new ExpertError('Retained hire history cannot be removed', 409);
  validateHireRequestTransitions(previous, next);
}

/** Preserve approval identity and correlate both directions of each newly introduced hire link. */
function validateHireRequestTransitions(previous: ExpertState, next: ExpertState): void {
  for (const request of previous.hireRequests) {
    const current = next.hireRequests.find((row) => row.id === request.id);
    if (
      !current ||
      current.owner !== request.owner ||
      current.requestedBy !== request.requestedBy ||
      current.templateId !== request.templateId ||
      current.templateSha256 !== request.templateSha256 ||
      JSON.stringify(current.fields) !== JSON.stringify(request.fields)
    )
      throw new ExpertError('Hire request identity and approved fields cannot be rewritten', 409);
    if (!request.hireId && !request.reservation) continue;
    if (
      (request.hireId && current.hireId !== request.hireId) ||
      (request.reservation &&
        (!current.reservation ||
          current.reservation.at !== request.reservation.at ||
          (request.reservation.phase === 'session-bound' &&
            (current.reservation.phase !== 'session-bound' ||
              current.reservation.sessionId !== request.reservation.sessionId)))) ||
      ['pending', 'declined', 'withdrawn'].includes(current.status)
    )
      throw new ExpertError('A linked hire approval cannot be cleared or replayed', 409);
  }
  const requestIds = new Set<string>();
  for (const request of next.hireRequests) {
    if (requestIds.has(request.id)) throw new ExpertError('Duplicate hire request identity', 409);
    requestIds.add(request.id);
    const old = previous.hireRequests.find((row) => row.id === request.id);
    if (
      request.reservation &&
      !old?.reservation &&
      (request.reservation.phase !== 'creation-issued' || request.status !== 'approving')
    )
      throw new ExpertError('A creation reservation must begin issued without an invented session identity', 409);
    if (!request.hireId || request.hireId === old?.hireId) continue;
    const hire = next.hires.find((row) => row.id === request.hireId);
    if (
      request.reservation?.phase !== 'session-bound' ||
      !hire ||
      hire.requestId !== request.id ||
      hire.owner !== request.owner ||
      hire.sessionId !== request.reservation.sessionId ||
      hire.templateId !== request.templateId ||
      hire.by !== 'owner' ||
      !['approving', 'approved'].includes(request.status)
    )
      throw new ExpertError(
        'A new hire approval link must match its reserved session, owner, template and request',
        409
      );
  }
  for (const hire of next.hires) {
    if (hire.startup.phase === 'legacy' || !hire.requestId) continue;
    const request = next.hireRequests.find((row) => row.id === hire.requestId);
    if (
      !request ||
      request.hireId !== hire.id ||
      request.owner !== hire.owner ||
      request.reservation?.phase !== 'session-bound' ||
      request.reservation.sessionId !== hire.sessionId ||
      request.templateId !== hire.templateId
    )
      throw new ExpertError('A retained requested hire must match its exact approval reservation', 409);
  }
}

/** Validate one template body for `id`, or throw an ExpertError naming the field (never the matched text). */
export function parseExpertTemplate(id: string, raw: unknown, now: number, previous?: ExpertTemplate): ExpertTemplate {
  if (!EXPERT_ID_PATTERN.test(id))
    throw new ExpertError('An expert id is lowercase letters, digits, - or _ (64 at most)');
  const parsed = ExpertTemplateBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'body';
    throw new ExpertError(`${field}: ${issue?.message ?? 'invalid'}`);
  }
  const { id: bodyId, ...body } = parsed.data;
  if (bodyId !== undefined && bodyId !== id) throw new ExpertError('The id in the body differs from the path');
  const hit = findCredential(body);
  if (hit) throw new ExpertError(`${hit}: looks like a credential; templates hold names only, never secrets`);
  return { id, ...body, createdAt: previous?.createdAt ?? now, updatedAt: now };
}

export function parseExpertSettings(raw: unknown): ExpertSettings {
  const parsed = ExpertSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ExpertError(`${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
  }
  return {
    ...parsed.data,
    hireDelegates: [...new Set(parsed.data.hireDelegates)],
    hireEmployeeDelegates: [...new Set(parsed.data.hireEmployeeDelegates)],
  };
}

const emptyState = (): ExpertState => ({
  version: 2,
  templates: [],
  settings: ExpertSettingsSchema.parse({}),
  hires: [],
  hireRequests: [],
});

/**
 * One writer for `experts.json`. A missing file is seeded once from `seedDir` (when given); an
 * unreadable or invalid file is reported and never overwritten, so the owner's data is not lost.
 */
export class ExpertStore {
  private state: ExpertState | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  /** A rejected write can have renamed the file already. This process must not write stale cached state. */
  private writeUncertain = false;

  get storageUncertain(): boolean {
    return this.writeUncertain;
  }

  assertWritable(): void {
    if (this.writeUncertain)
      throw new ExpertError(
        'Hiring storage has an unconfirmed write; reload it through a fresh console process before changing hires',
        503
      );
  }

  constructor(
    readonly file: string,
    private readonly seedDir?: string,
    private readonly now: () => number = Date.now
  ) {}

  /** Load once (seeding a missing file); later calls return at once. Throws 503 on a damaged file. */
  async load(): Promise<void> {
    if (this.state) return;
    const run = this.chain.then(async () => {
      if (this.state) return;
      let text: string | undefined;
      try {
        text = await fs.readFile(this.file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (text === undefined) {
        const seeded = await this.seed();
        if (seeded.templates.length) await writeCompanyStateFile(this.file, JSON.stringify(seeded, null, 2));
        this.state = seeded;
        return;
      }
      const parsed = (() => {
        try {
          const raw: unknown = JSON.parse(text);
          const legacy = LegacyExpertStateSchema.safeParse(raw);
          return ExpertStateSchema.safeParse(
            legacy.success
              ? {
                  ...legacy.data,
                  version: 2,
                  hires: legacy.data.hires.map((hire) => ({ ...hire, startup: { phase: 'legacy' } })),
                }
              : raw
          );
        } catch {
          return undefined;
        }
      })();
      if (!parsed?.success)
        throw new ExpertError(`${basename(this.file)} is damaged; fix or move it aside (nothing was changed)`, 503);
      this.state = parsed.data;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async seed(): Promise<ExpertState> {
    const state = emptyState();
    if (!this.seedDir) return state;
    let names: string[];
    try {
      names = (await fs.readdir(this.seedDir)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return state;
    }
    for (const name of names) {
      if (state.templates.length >= MAX_EXPERT_TEMPLATES) break;
      try {
        const raw = JSON.parse(await fs.readFile(join(this.seedDir, name), 'utf8')) as Record<string, unknown>;
        const id = typeof raw?.id === 'string' ? raw.id : name.slice(0, -'.json'.length);
        if (state.templates.some((t) => t.id === id)) continue;
        state.templates.push(parseExpertTemplate(id, { ...raw, id }, this.now()));
      } catch (error) {
        console.error(`[experts] ignoring seed ${name}:`, error instanceof Error ? error.message : error);
      }
    }
    return state;
  }

  snapshot(): ExpertState {
    if (!this.state) throw new ExpertError('Expert templates are not loaded', 503);
    return structuredClone(this.state);
  }

  /** Publish only a confirmed write. A write rejection fences further writes until a fresh process reloads disk. */
  async update<T>(mutate: (state: ExpertState) => T, validateAuthority: () => void = () => {}): Promise<T> {
    await this.load();
    const run = this.chain.then(async () => {
      this.assertWritable();
      validateAuthority();
      const next = structuredClone(this.state!);
      const result = mutate(next);
      ExpertStateSchema.parse(next);
      validateHireTransitions(this.state!, next);
      let beforePublishRefusal: { proof: Error; cause: unknown } | undefined;
      try {
        await writeCompanyStateFile(this.file, JSON.stringify(next, null, 2), () => {
          try {
            validateAuthority();
          } catch (cause) {
            // The canonical writer invokes this before rename. This exact private exception
            // proves this publication was refused; no public flag/error text can stand in for it.
            beforePublishRefusal = { proof: new Error('Expert publication authority refused'), cause };
            throw beforePublishRefusal.proof;
          }
        });
      } catch (error) {
        if (beforePublishRefusal && error === beforePublishRefusal.proof) throw beforePublishRefusal.cause;
        this.writeUncertain = true;
        throw error;
      }
      this.state = next;
      return structuredClone(result);
    });
    this.chain = run.catch(() => {});
    return run;
  }
}

export interface SessionLaunch {
  workingDir: string;
  mode: string;
  name: string;
  icon: string;
  model?: string;
  effort?: string;
  accountProfileId?: string;
}

/**
 * The `POST /api/sessions` body for a launch. A Claude model is the top-level `model`; a CLI that
 * takes `--model` gets it in its own config object, as the session route reads it; a CLI with no
 * model is refused rather than silently dropping one.
 */
export function sessionCreateBody(launch: SessionLaunch): Record<string, unknown> {
  const body: Record<string, unknown> = {
    workingDir: launch.workingDir,
    mode: launch.mode,
    name: launch.name,
    icon: launch.icon,
  };
  if (launch.accountProfileId) body.subscriptionProfileId = launch.accountProfileId;
  if (launch.effort) body.effort = launch.effort;
  if (launch.model) {
    const entry = getCli(launch.mode);
    const source = entry?.capabilities.model;
    const field = entry?.launch.legacyConfigField;
    if (source?.source === 'claude-settings-file') body.model = launch.model;
    else if (source?.source === 'flag' && field) body[field] = { [source.param ?? 'model']: launch.model };
    else throw new ExpertError(`The ${launch.mode} CLI takes no model setting here`);
  }
  return body;
}
