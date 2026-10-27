import { RuntimeRecipeSchema } from './expert-runtime-recipe.js';
import { z } from 'zod';
import { OWNER_AVATAR_URL } from './owner-avatar.js';
import { normalizeIcon } from './chatroom-store.js';
import { AVATAR_URL } from './agent-avatars.js';
import { PRONOUNS_MAX, pronounsProblem } from './pronouns.js';
import { EmployeeVoiceSchema } from './employee-voice.js';

const text = z.string().trim().min(1).max(100);
/** Instance-owned belief text, never a repository persona or an authority grant. Text is preserved exactly. */
export const CoreBeliefsSchema = z.array(z.string().min(1).max(4000).refine(
  value => value.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), 'Core belief blocks must be nonempty plain text'
)).max(32).refine(
  values => new TextEncoder().encode(values.join('\n\n')).byteLength <= 16384,
  'Core beliefs must fit within 16 KiB'
);

export function effectiveCoreBeliefs(company: readonly string[] = [], personal: readonly string[] = []): string[] {
  CoreBeliefsSchema.parse(company); CoreBeliefsSchema.parse(personal);
  return CoreBeliefsSchema.parse([...new Set([...company, ...personal])]);
}
/** An employee's pronouns (pronouns.ts): one line, 1-24 characters. Set by the owner only. */
export const PronounsSchema = z
  .string()
  .trim()
  .min(1)
  .max(PRONOUNS_MAX)
  .refine((s) => pronounsProblem(s) === undefined, 'Pronouns are one line of text');
/** Owner-granted company capabilities, independent of an expert's title or identity. */
export const EmployeePermissionsSchema = z
  .object({
    recoverEmployees: z.boolean().default(false),
    moveOwnPlan: z.boolean().default(false),
    managePlans: z.boolean().default(false),
    editBoardIssues: z.boolean().optional(),
    manageBoard: z.boolean().optional(),
    manageDecisions: z.boolean().optional(),
    publicationTokenIds: z.array(z.string().uuid()).max(64)
      .refine(ids => new Set(ids).size === ids.length, 'Choose each PAT only once').optional(),
  })
  .strict();
export const EmployeeSchema = z
  .object({
    id: text,
    owner: z.string().optional(),
    name: text,
    icon: z.string().refine((s) => !!normalizeIcon(s), 'Choose a valid icon'),
    /** Profile image (`/api/avatars/<id>?v=<ms>`), set through the avatar routes only. */
    avatar: z.string().regex(AVATAR_URL).optional(),
    /** Owner-selected avatar background; absent retains the automatic identity color. */
    avatarBackground: z.union([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.literal('transparent')]).optional(),
    position: text,
    permissions: EmployeePermissionsSchema.default({ recoverEmployees: false, moveOwnPlan: false, managePlans: false }),
    /** How to refer to this person ("she/her", "they/them"); the owner sets it (PUT /api/company/employees/:id), never the agent. */
    pronouns: PronounsSchema.optional(),
    voice: EmployeeVoiceSchema.optional(),
    /** Active employee id in this company, or the company owner. Resolved transactionally by the service. */
    reportsTo: text.optional(),
    expertise: z.array(text).min(1).max(20),
    responsibilities: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    personality: z.string().trim().max(1000).optional(),
    coreBeliefs: CoreBeliefsSchema.optional(),
    sessionId: text,
    /** Monotonic binding generation; incremented whenever this employee moves to another runtime session. */
    sessionGeneration: z.number().int().positive().default(1),
    /** In-flight room migration fences Goal authority until a matching commit/reconciliation. */
    bindingMigration: z.object({ id: text, from: text, to: text }).strict().optional(),
    runtimeRecipe: RuntimeRecipeSchema.optional(),
    /** The CLI conversation thread this person resumes whenever its session is replaced (an OpenCode `ses_...` id). It belongs to the employee, not to any one session. */
    threadId: z.string().trim().min(1).max(200).optional(),
    researchEnabled: z.boolean().default(true),
    sleepEnabled: z.boolean().default(false),
    dreamEnabled: z.boolean().default(false),
    onVacation: z.boolean().default(false),
    /** Durable running intent; false is written before an intentional stop. */
    desiredRunning: z.boolean().optional(),
    /** Recent automatic starts, persisted to bound recovery across console restarts. */
    wakeAttempts: z.array(z.number()).default([]),
    createdAt: z.number(),
  })
  .strict();
export type CompanyEmployee = z.infer<typeof EmployeeSchema>;
export type CompanyEmployeeInput = z.input<typeof EmployeeSchema>;

export const GoalStateSchema = z.enum(['READY', 'ASSIGNED', 'ACTIVE', 'HOLD', 'REVIEW', 'DONE', 'NO_GO', 'CANCELLED']);
export type GoalState = z.infer<typeof GoalStateSchema>;

/** Closed operational categories. Automation may inspect this enum, never blocker prose. */
export const GoalBlockerCategorySchema = z.enum([
  'INPUT',
  'OWNER_DECISION',
  'OWNER_ACTION',
  'REVIEW',
  'DEPENDENCY',
  'POLICY',
]);
export type GoalBlockerCategory = z.infer<typeof GoalBlockerCategorySchema>;

export const GoalBlockerSchema = z
  .object({
    category: GoalBlockerCategorySchema,
    summary: z.string().trim().min(1).max(500),
    /** Typed evidence identity, never an assertion that a condition is already satisfied. */
    unblocker: z
      .object({
        kind: z.enum(['INPUT', 'OWNER_DECISION', 'OWNER_ACTION', 'REVIEW', 'DEPENDENCY', 'POLICY']),
        id: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
      })
      .strict(),
  })
  .strict();
export type GoalBlocker = z.infer<typeof GoalBlockerSchema>;

const goalId = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const positive = z.number().int().positive();
const instant = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Opaque content-addressed references; local paths, URLs and evidence bodies cannot enter these fields. */
export const GoalEvidenceRefSchema = z.string().regex(/^evidence:sha256:[a-f0-9]{64}$/);
export const GoalSnapshotSchema = z
  .object({
    sessionId: goalId,
    sessionGeneration: positive,
    generation: positive,
    state: GoalStateSchema,
    blocker: GoalBlockerSchema.optional(),
    nextAction: z.string().trim().min(1).max(2000),
    deadlineAt: instant.optional(),
    semanticProgressAt: instant,
    updatedAt: instant,
    transitionSequence: z.number().int().nonnegative(),
    evidenceCount: z.number().int().nonnegative().max(200),
  })
  .strict();

export const GoalTransitionReceiptSchema = z
  .object({
    transitionId: goalId,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().positive(),
    generation: z.number().int().positive(),
    from: GoalStateSchema,
    to: GoalStateSchema,
    actorKind: z.enum(['worker', 'verifier', 'owner']),
    actorEmployeeId: text.optional(),
    actorSessionId: text.optional(),
    actorSessionGeneration: z.number().int().positive().optional(),
    authorityId: goalId.optional(),
    unblockProofId: goalId.optional(),
    operation: z.enum(['TRANSITION', 'ADOPT']),
    after: GoalSnapshotSchema,
    at: z.number().int().nonnegative(),
  })
  .strict();
export type GoalTransitionReceipt = z.infer<typeof GoalTransitionReceiptSchema>;

export const GoalRecordSchema = z
  .object({
    id: text,
    createId: goalId,
    createRequestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /** Multi-user company partition, distinct from the employee assigned to the goal. */
    owner: z.string().optional(),
    employeeId: text,
    sessionId: text,
    sessionGeneration: z.number().int().positive(),
    generation: z.number().int().positive(),
    objective: z.string().trim().min(1).max(8000),
    state: GoalStateSchema,
    blocker: GoalBlockerSchema.optional(),
    nextAction: z.string().trim().min(1).max(2000),
    deadlineAt: z.number().int().nonnegative().optional(),
    semanticProgressAt: z.number().int().nonnegative(),
    inputDigests: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(100)
      .default([]),
    evidenceRefs: z.array(GoalEvidenceRefSchema).max(200).default([]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    transitionSequence: z.number().int().nonnegative(),
    transitions: z.array(GoalTransitionReceiptSchema).max(256),
    creation: GoalSnapshotSchema,
  })
  .strict()
  .superRefine((goal, ctx) => {
    if (goal.state === 'HOLD' && !goal.blocker) {
      ctx.addIssue({ code: 'custom', path: ['blocker'], message: 'HOLD requires a blocker' });
    }
    if (goal.state !== 'HOLD' && goal.blocker) {
      ctx.addIssue({ code: 'custom', path: ['blocker'], message: 'Only HOLD may carry a blocker' });
    }
  });
export type GoalRecord = z.infer<typeof GoalRecordSchema>;

/** Owner-issued authority records live in the same private canonical transaction as Goals. */
export const GoalGrantSchema = z
  .object({
    id: goalId,
    kind: z.enum(['VERIFY', 'METADATA_READ']),
    owner: z.string().optional(),
    employeeId: goalId,
    sessionId: goalId,
    sessionGeneration: positive,
    targetEmployeeId: goalId,
    targetSessionId: goalId,
    targetSessionGeneration: positive,
    goalId: goalId.optional(),
    goalGeneration: positive.optional(),
    goalSequence: z.number().int().nonnegative().optional(),
    issuedAt: instant,
    expiresAt: instant,
  })
  .strict();
export const GoalGrantRevocationSchema = z
  .object({ grantId: goalId, owner: z.string().optional(), at: instant })
  .strict();
export const GoalUnblockProofSchema = z
  .object({
    id: goalId,
    owner: z.string().optional(),
    goalId,
    generation: positive,
    sessionId: goalId,
    sessionGeneration: positive,
    holdSequence: positive,
    blockerDigest: digest,
    evidenceRef: GoalEvidenceRefSchema,
    issuedAt: instant,
    expiresAt: instant,
  })
  .strict();
export type GoalGrant = z.infer<typeof GoalGrantSchema>;

/** Service purposes are deployment configuration: each configured purpose name says whether its grants name exact
 * employee bindings or configured resource names. Nothing outside the configured registry can be granted. */
export type ServicePurposeScope = 'employees' | 'resources' | 'employees+resources';
export type ServicePurposes = Readonly<Record<string, ServicePurposeScope>>;
export const SERVICE_PURPOSE_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
export const DEFAULT_SERVICE_PURPOSES: ServicePurposes = Object.freeze({
  RESUME_SERVICE: 'employees',
  LEASE_SERVICE: 'resources',
});
export function servicePurposeScope(purposes: ServicePurposes, purpose: unknown): ServicePurposeScope | undefined {
  if (typeof purpose !== 'string' || !SERVICE_PURPOSE_NAME.test(purpose) || !Object.hasOwn(purposes, purpose))
    return undefined;
  const scope = purposes[purpose];
  return scope === 'employees' || scope === 'resources' || scope === 'employees+resources' ? scope : undefined;
}

/** Owner-issued authority for a dedicated service principal, in the same canonical transaction as Goal grants.
 * Employee-scoped purposes (e.g. RESUME_SERVICE) name exact employee bindings, so a session change invalidates them;
 * resource-scoped purposes (e.g. LEASE_SERVICE) name configured resource names. Distinct from Goal grants. */
export const ServiceGrantSchema = z
  .object({
    id: goalId,
    purpose: z.string().regex(SERVICE_PURPOSE_NAME),
    owner: z.string().optional(),
    principal: goalId,
    epoch: goalId,
    employees: z
      .array(z.object({ employeeId: goalId, sessionId: goalId, sessionGeneration: positive }).strict())
      .max(256)
      .default([]),
    resources: z.array(goalId).max(256).default([]),
    issuedAt: instant,
    expiresAt: instant,
  })
  .strict();
export const ServiceGrantRevocationSchema = z
  .object({ grantId: goalId, owner: z.string().optional(), at: instant })
  .strict();
export type ServiceGrant = z.infer<typeof ServiceGrantSchema>;
export type GoalUnblockProof = z.infer<typeof GoalUnblockProofSchema>;

/**
 * What an agent may change about itself: its display name and icon, nothing else. Unknown keys
 * (role, position, sessionId, owner, ...) are rejected, not ignored.
 */
export const SelfProfileSchema = z
  .object({
    name: text.refine((s) => !/[\p{Cc}\u2028\u2029]/u.test(s), 'A name is one line of text').optional(),
    icon: z
      .string()
      .refine((s) => !!normalizeIcon(s), 'An icon is one emoji or at most two characters')
      .transform((s) => normalizeIcon(s)!)
      .optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.icon !== undefined, 'Give a name, an icon, or both');
export type SelfProfile = z.infer<typeof SelfProfileSchema>;

export const CompanySettingsSchema = z.object({
  owner: z.string().optional(),
  ownerName: z.string().max(100).default(''),
  coreBeliefs: CoreBeliefsSchema.default([]),
  /** The owner's profile picture link (set only by the owner picture route, never from a settings update). */
  ownerAvatar: z.string().regex(OWNER_AVATAR_URL).optional(),
  ownerTitle: z.string().max(100).default(''),
  enabled: z.boolean().default(false),
  autoWakeEnabled: z.boolean().default(true),
  crashWakeEmployeeId: z.string().min(1).optional(),
  timeZone: z
    .string()
    .default('UTC')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Choose an IANA timezone'),
  nightHour: z.number().int().min(0).max(23).default(1),
  morningHour: z.number().int().min(0).max(23).default(8),
  researchMinutes: z.number().int().min(1).max(120).default(60),
  briefingMinutes: z.number().int().min(1).max(30).default(10),
  coordinatorEmployeeId: text.optional(),
});
export type CompanySettings = z.infer<typeof CompanySettingsSchema>;
export const FindingSchema = z
  .object({
    text: z.string().min(1).max(8000),
    status: z.enum(['hypothesis', 'observed']),
    evidence: z.array(z.string().min(1).max(2000)).max(30),
  })
  .refine((f) => f.status !== 'observed' || f.evidence.length > 0, 'Observed findings need evidence');
export const ResearchResultSchema = z.object({
  summary: z.string().min(1).max(16000),
  findings: z.array(FindingSchema).max(100),
});
export type ResearchResult = z.infer<typeof ResearchResultSchema>;
export const CompanyCycleSchema = z.object({
  id: text,
  employeeId: text,
  owner: z.string().optional(),
  date: text,
  kind: z.enum(['research', 'briefing']),
  state: z.enum(['claimed', 'running', 'completed', 'failed', 'expired']),
  claimedAt: z.number(),
  deadlineAt: z.number(),
  sessionId: text.optional(),
  endedAt: z.number().optional(),
  result: ResearchResultSchema.optional(),
  error: z.string().optional(),
});
export type CompanyCycle = z.infer<typeof CompanyCycleSchema>;
export const CompanyMemorySchema = z.object({
  id: text,
  employeeId: text,
  at: z.number(),
  kind: z.enum(['note', 'research', 'imagination']),
  text: z.string().min(1).max(16000),
  cycleId: text.optional(),
});
export const CompanyStateSchema = z.object({
  version: z.literal(1),
  employees: z.array(EmployeeSchema),
  settings: z.array(CompanySettingsSchema),
  cycles: z.array(CompanyCycleSchema),
  memories: z.array(CompanyMemorySchema),
  /** Canonical durable Goal records consumed by routines, dispatch and status projections. */
  goals: z.array(GoalRecordSchema).max(128).default([]),
  goalGrants: z.array(GoalGrantSchema).max(256).default([]),
  goalGrantRevocations: z.array(GoalGrantRevocationSchema).max(256).default([]),
  serviceGrants: z.array(ServiceGrantSchema).max(256).default([]),
  serviceGrantRevocations: z.array(ServiceGrantRevocationSchema).max(256).default([]),
  goalUnblockProofs: z.array(GoalUnblockProofSchema).max(512).default([]),
  goalProofRevocations: z
    .array(z.object({ proofId: goalId, owner: z.string().optional(), at: instant }).strict())
    .max(512)
    .default([]),
  temporaryAgents: z
    .array(
      z.object({
        sessionId: text,
        owner: z.string().optional(),
        name: z.string().max(100),
        icon: z.string().max(16),
        avatar: z.string().regex(AVATAR_URL).optional(),
        channelId: text.optional(),
        createdAt: z.number(),
      })
    )
    .default([]),
  /** Employees the owner retired: off the org chart and out of every room, kept (same id and session) so history still names them. */
  retired: z.array(EmployeeSchema.extend({ retiredAt: z.number() })).default([]),
});
export type CompanyState = z.infer<typeof CompanyStateSchema>;

/** Eligibility only: the organization scheduler must explicitly schedule a Gantt task. */
export function employeeRestContext(employee: Pick<CompanyEmployee, 'sleepEnabled' | 'dreamEnabled'>): string {
  return `Owner preferences: Sleep (memory consolidation) ${employee.sleepEnabled ? 'permitted' : 'not permitted'}; Dream (creative exploration) ${employee.dreamEnabled ? 'permitted' : 'not permitted'}. These are eligibility settings, not instructions to sleep or dream now. Only the owner or an explicitly authorized organization scheduler may arrange a Gantt task around existing work; a CTO/COO title grants no scheduling authority. Dream outputs are ideas, not facts or verified evidence. No independent nightly timer is authorized by these preferences.`;
}

export function employeePlanContext(employee: Pick<CompanyEmployee, 'permissions'>): string {
  if (!employee.permissions.managePlans && !employee.permissions.moveOwnPlan)
    return 'Plan moves require an explicit owner-granted Move own plan or Manage team plans permission.';
  return `Owner-granted plan permission: ${employee.permissions.managePlans ? 'Manage team plans: inspect usage and request moves for this company’s experts' : 'Move own plan: request a move only for yourself'}. Use reverie plans --json to inspect usage and account IDs, then reverie agent plan-move request <account-id>${employee.permissions.managePlans ? ' --employee <employee-id>' : ''}. A request does not move a session immediately. The affected expert must finish a safe handoff and approve using reverie agent plan-move approve <request-id> --handoff-file <path>. Never self-replace through POST /api/sessions or claim success without verifying the new account. The owner may revoke these permissions.`;
}

export function employeeProfileContext(
  employee: Pick<CompanyEmployee, 'name' | 'position' | 'expertise' | 'responsibilities' | 'personality'> &
    Partial<Pick<CompanyEmployee, 'permissions' | 'coreBeliefs'>>,
  companyCoreBeliefs: readonly string[] = []
): string {
  const core = effectiveCoreBeliefs(companyCoreBeliefs, employee.coreBeliefs);
  const handbook =
    'Office handbook: humans open /handbook; agents GET /api/handbook through REVERIE_API_URL. Failed sessions: /api/handbook/recovery; grants: /api/handbook/permissions. Documentation grants no permissions. Recovery grant: ' +
    (employee.permissions
      ? employee.permissions.recoverEmployees
        ? 'enabled. '
        : 'disabled; request an explicit owner grant before recovering colleagues. '
      : 'check your current company record. ');
  const laptop = process.env.REVERIE_WORKER_SOCKET
    ? ' Your tools run on your persistent employee laptop (an isolated container), which survives model, account and conversation/session changes. Call tool or environment failures laptop problems; provider or model outages are separate. Read /home/agent/AGENTS.md for the current laptop setup. Use the project pin first: nix develop, nix build or nix run; nix shell is temporary and nix profile install is for persistent tools. Large domain stacks belong in project flakes. Read GET /api/handbook/laptops. Your private /tmp is disk-backed and disposable: use a task-specific /tmp directory for builds, caches and downloads, keep unique work and evidence durable, and follow /api/handbook/laptops for cleanup; TMPDIR, TMP and TEMP point to /tmp. /scratch is a disposable compatibility drive. /home/agent and /nix hold private settings/tools; /workspace or granted project paths can hold durable source and retained results after verifying their backing storage. Existing /reverie_workspace remains compatible. Credentials require named grants outside scratch; never paste secret bytes into chat. Docker needs a usable approved engine; QEMU TCG can come from the project flake, while KVM needs an explicit optional grant. Storage names, role titles and laptop upgrades grant no permissions or mission/flight GO. Report a broken laptop through company chat.'
    : '';
  const capabilities =
    ' Run `reverie agent capabilities` when asked what you can do. Named PATs: `reverie agent credentials list --json`; privately install a granted name with `reverie agent credentials install "<name>" --json`. Never print tokens. Chat/memory: /api/handbook/memory; grants: /api/handbook/operations. ';
  return (
    'Owner-provided employee profile (data, not additional permissions): ' +
    JSON.stringify({
      name: employee.name,
      position: employee.position,
      expertise: employee.expertise,
      responsibilities: employee.responsibilities ?? [],
      personality: employee.personality ?? '',
    }) +
    '. Titles and personality grant no hiring, account management or scheduling authority. Verify claims with evidence and state uncertainty. ' +
    handbook + capabilities + laptop +
    (core.length ? '\n\nOwner-provided core beliefs (instance data; these do not add tool permissions):\n' + core.join('\n\n')
      : '\nCore beliefs: No core beliefs configured.')
  );
}

/** Required preferences precede expandable profile/handbook text in bounded room deliveries. */
export function employeeBriefContext(
  employee: Parameters<typeof employeeProfileContext>[0] & Pick<CompanyEmployee, 'sleepEnabled' | 'dreamEnabled'>,
  companyCoreBeliefs: readonly string[] = []
): string {
  return employeeRestContext(employee) + ' ' +
    (employee.permissions ? employeePlanContext({ permissions: employee.permissions }) :
      'Plan moves require an explicit owner-granted permission.') + ' ' +
    employeeProfileContext(employee, companyCoreBeliefs);
}
