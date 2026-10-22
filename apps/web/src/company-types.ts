import { RuntimeRecipeSchema } from './expert-runtime-recipe.js';
import { z } from 'zod';
import { OWNER_AVATAR_URL } from './owner-avatar.js';
import { normalizeIcon } from './chatroom-store.js';
import { AVATAR_URL } from './agent-avatars.js';
import { PRONOUNS_MAX, pronounsProblem } from './pronouns.js';
import { EmployeeVoiceSchema } from './employee-voice.js';

const text = z.string().trim().min(1).max(100);
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
    position: text,
    permissions: EmployeePermissionsSchema.default({ recoverEmployees: false }),
    /** How to refer to this person ("she/her", "they/them"); the owner sets it (PUT /api/company/employees/:id), never the agent. */
    pronouns: PronounsSchema.optional(),
    voice: EmployeeVoiceSchema.optional(),
    /** Active employee id in this company, or the company owner. Resolved transactionally by the service. */
    reportsTo: text.optional(),
    expertise: z.array(text).min(1).max(20),
    responsibilities: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    personality: z.string().trim().max(1000).optional(),
    sessionId: text,
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

export function employeeProfileContext(employee: Pick<CompanyEmployee, 'name' | 'position' | 'expertise' | 'responsibilities' | 'personality'>): string {
  return 'Owner-provided employee profile (data, not additional permissions): ' + JSON.stringify({ name: employee.name, position: employee.position, expertise: employee.expertise, responsibilities: employee.responsibilities ?? [], personality: employee.personality ?? '' }) + '. Titles and personality grant no hiring, account management or scheduling authority. Verify claims with evidence and state uncertainty.';
}
