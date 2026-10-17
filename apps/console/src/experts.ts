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
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
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
  .strict();
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

export const ExpertHireSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  sessionId: z.string(),
  employeeId: z.string(),
  /** 'owner' or 'agent:<session id>'. */
  by: z.string(),
  reason: z.string(),
  hiredAt: z.number(),
  status: z.enum(['active', 'retired']),
  retiredAt: z.number().optional(),
  retiredBy: z.string().optional(),
  retireReason: z.string().optional(),
  budgetStop: BudgetStopSchema.optional(),
});
export type ExpertHire = z.infer<typeof ExpertHireSchema>;

export const ExpertStateSchema = z.object({
  version: z.literal(1),
  templates: z.array(ExpertTemplateSchema),
  settings: ExpertSettingsSchema,
  hires: z.array(ExpertHireSchema),
});
export type ExpertState = z.infer<typeof ExpertStateSchema>;

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
  return { ...parsed.data, hireDelegates: [...new Set(parsed.data.hireDelegates)] };
}

const emptyState = (): ExpertState => ({
  version: 1,
  templates: [],
  settings: ExpertSettingsSchema.parse({}),
  hires: [],
});

/**
 * One writer for `experts.json`. A missing file is seeded once from `seedDir` (when given); an
 * unreadable or invalid file is reported and never overwritten, so the owner's data is not lost.
 */
export class ExpertStore {
  private state: ExpertState | undefined;
  private chain: Promise<unknown> = Promise.resolve();

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
          return ExpertStateSchema.safeParse(JSON.parse(text));
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

  /** Apply `mutate` to a copy, validate, write it whole, then publish it. A throw changes nothing. */
  async update<T>(mutate: (state: ExpertState) => T): Promise<T> {
    await this.load();
    const run = this.chain.then(async () => {
      const next = structuredClone(this.state!);
      const result = mutate(next);
      ExpertStateSchema.parse(next);
      await writeCompanyStateFile(this.file, JSON.stringify(next, null, 2));
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
