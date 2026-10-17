import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CompanyCycleSchema,
  ResearchResultSchema,
  type CompanyCycle,
  type CompanyEmployee,
  type ResearchResult,
} from './company-types.js';
import type { CompanyResearchBackend, ResearchHandle } from './company-service.js';
import { writeCompanyStateFile } from './company-store.js';

const BindingSchema = z.object({
  cycleId: z.string().uuid(),
  employeeId: z.string().min(1),
  owner: z.string().optional(),
  sessionId: z.string().uuid(),
  workingDir: z.string(),
  deadlineAt: z.number(),
  phase: z.enum(['launching', 'running', 'completed', 'failed', 'stopped']),
  result: ResearchResultSchema.optional(),
  error: z.string().optional(),
});
export type CompanyResearchBinding = z.infer<typeof BindingSchema>;
export interface CompanyResearchRuntime {
  /** Create exactly this dedicated session; resolve after launch, never after the whole task. */
  launch(input: {
    binding: CompanyResearchBinding;
    employee: CompanyEmployee;
    prompt: string;
    env: Record<string, string>;
  }): Promise<void>;
  /** Read actual CLI state/output, never generate or simulate a report. */
  inspect(binding: CompanyResearchBinding): Promise<{
    state: 'running' | 'completed' | 'failed' | 'missing';
    response?: string;
    error?: string;
    /** Exact evidence receipts independently collected from real tools or checked artifacts. */
    evidence?: string[];
  }>;
  stop(binding: CompanyResearchBinding): Promise<void>;
}
export interface DurableCompanyResearchDeps {
  file: string;
  workspaceRoot: string;
  runtime: CompanyResearchRuntime;
  now?: () => number;
}
const MAX_REPORT_BYTES = 256 * 1024;

/** Strict bounded parsing. Model-supplied evidence alone never establishes an observed result. */
export function parseResearchReport(response: string, receipts: string[] = []): ResearchResult {
  if (Buffer.byteLength(response, 'utf8') > MAX_REPORT_BYTES) throw new Error('Research report exceeds 256 KiB');
  const raw = response
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '');
  const result = ResearchResultSchema.parse(JSON.parse(raw));
  const actual = new Set(receipts.filter((r) => r.length <= 2000));
  for (const finding of result.findings) {
    finding.evidence = finding.evidence.filter((e) => actual.has(e));
    if (finding.status === 'observed' && finding.evidence.length === 0) finding.status = 'hypothesis';
  }
  return result;
}

/**
 * Durable ownership around real tool sessions. A launch intent is persisted before
 * runtime IO. A missing session after uncertain launch is failed, never replayed.
 * One instance owns each file; server startup must initialize it before ticking.
 */
export class DurableCompanyResearchBackend implements CompanyResearchBackend {
  private bindings = new Map<string, CompanyResearchBinding>();
  private chain: Promise<unknown> = Promise.resolve();
  private initialized = false;
  constructor(private readonly deps: DurableCompanyResearchDeps) {}

  async init(): Promise<void> {
    try {
      const records = z.array(BindingSchema).parse(JSON.parse(await fs.readFile(this.deps.file, 'utf8')));
      for (const binding of records) {
        this.checkPath(binding);
        if (this.bindings.has(binding.cycleId)) throw new Error('Duplicate research binding');
        this.bindings.set(binding.cycleId, binding);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private checkPath(binding: CompanyResearchBinding): void {
    if (resolve(binding.workingDir) !== resolve(this.deps.workspaceRoot, binding.cycleId))
      throw new Error('Research workspace is not owned by this cycle');
  }
  private async checkWorkspace(binding: CompanyResearchBinding): Promise<void> {
    this.checkPath(binding);
    const [root, working, info] = await Promise.all([
      fs.realpath(this.deps.workspaceRoot),
      fs.realpath(binding.workingDir),
      fs.lstat(binding.workingDir),
    ]);
    if (!info.isDirectory() || working !== join(root, binding.cycleId))
      throw new Error('Research workspace may not be redirected through a symlink');
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => {
      if (!this.initialized) throw new Error('Initialize research backend before use');
      return work();
    });
    this.chain = next.catch(() => {});
    return next;
  }
  private async save(binding: CompanyResearchBinding): Promise<void> {
    const records = new Map(this.bindings);
    records.set(binding.cycleId, structuredClone(binding));
    await writeCompanyStateFile(this.deps.file, JSON.stringify([...records.values()]));
    this.bindings = records;
  }
  private handle(binding: CompanyResearchBinding): ResearchHandle {
    return {
      cycleId: binding.cycleId,
      employeeId: binding.employeeId,
      owner: binding.owner,
      sessionId: binding.sessionId,
      dedicated: true,
      state:
        binding.phase === 'completed'
          ? 'completed'
          : ['failed', 'stopped'].includes(binding.phase)
            ? 'failed'
            : 'running',
      result: binding.result,
      error: binding.error,
    };
  }

  start(input: { cycle: CompanyCycle; employee: CompanyEmployee; prompt: string }): Promise<ResearchHandle> {
    return this.serial(async () => {
      const cycle = CompanyCycleSchema.parse(input.cycle);
      if (cycle.employeeId !== input.employee.id || cycle.owner !== input.employee.owner)
        throw new Error('Research employee ownership mismatch');
      const existing = this.bindings.get(cycle.id);
      if (existing) {
        if (
          existing.employeeId !== cycle.employeeId ||
          existing.owner !== cycle.owner ||
          existing.deadlineAt !== cycle.deadlineAt
        )
          throw new Error('Research cycle binding mismatch');
        return this.inspectBinding(existing);
      }
      if (this.now() >= cycle.deadlineAt) throw new Error('Research budget already elapsed');
      const binding: CompanyResearchBinding = {
        cycleId: cycle.id,
        employeeId: cycle.employeeId,
        owner: cycle.owner,
        sessionId: randomUUID(),
        workingDir: resolve(this.deps.workspaceRoot, cycle.id),
        deadlineAt: cycle.deadlineAt,
        phase: 'launching',
      };
      BindingSchema.parse(binding);
      await fs.mkdir(binding.workingDir, { recursive: true, mode: 0o700 });
      await this.checkWorkspace(binding);
      await this.save(binding);
      await fs.writeFile(
        join(binding.workingDir, 'RESEARCH_TASK.md'),
        `${input.prompt}\n\nEvidence is reviewed against actual runtime tool receipts. Uncorroborated observations remain hypotheses.\n`,
        { mode: 0o600 }
      );
      // A runtime may launch before throwing. Leave its durable intent for inspect;
      // never replay it or stop an unverified process here.
      await this.deps.runtime.launch({
        binding: structuredClone(binding),
        employee: input.employee,
        prompt: input.prompt,
        env: {
          FLEET_RESEARCH_CYCLE_ID: cycle.id,
          FLEET_EMPLOYEE_ID: input.employee.id,
          FLEET_RESEARCH_DEADLINE_AT: String(cycle.deadlineAt),
        },
      });
      binding.phase = 'running';
      await this.save(binding);
      return this.handle(binding);
    });
  }

  inspect(cycleId: string): Promise<ResearchHandle | undefined> {
    return this.serial(async () => {
      const binding = this.bindings.get(cycleId);
      return binding ? this.inspectBinding(binding) : undefined;
    });
  }
  private async inspectBinding(saved: CompanyResearchBinding): Promise<ResearchHandle> {
    const binding = structuredClone(saved);
    if (['completed', 'failed', 'stopped'].includes(binding.phase)) return this.handle(binding);
    this.checkPath(binding);
    try {
      await this.checkWorkspace(binding);
    } catch {
      // Workspace contents are untrusted now. The runtime checks the persisted
      // session identity directly; cleanup must not depend on following its cwd.
      await this.deps.runtime.stop(structuredClone(binding));
      binding.phase = 'failed';
      binding.error = 'Dedicated research workspace is missing or invalid; bound session stopped';
      await this.save(binding);
      return this.handle(binding);
    }
    const state = await this.deps.runtime.inspect(structuredClone(binding));
    if (state.state === 'completed') {
      try {
        binding.result = parseResearchReport(state.response ?? '', state.evidence);
        binding.phase = 'completed';
      } catch {
        binding.phase = 'failed';
        binding.error = 'Actual agent response was not a valid bounded research report';
      }
    } else if (state.state === 'failed' || state.state === 'missing') {
      binding.phase = 'failed';
      binding.error =
        state.error?.slice(0, 2000) ??
        (state.state === 'missing'
          ? 'Dedicated research session missing after launch intent; work was not replayed'
          : 'Dedicated research session failed');
    } else binding.phase = 'running';
    await this.save(binding);
    return this.handle(binding);
  }

  stop(cycleId: string): Promise<void> {
    return this.serial(async () => {
      const saved = this.bindings.get(cycleId);
      if (!saved || ['completed', 'failed', 'stopped'].includes(saved.phase)) return;
      const binding = structuredClone(saved);
      this.checkPath(binding);
      await this.deps.runtime.stop(structuredClone(binding));
      binding.phase = 'stopped';
      binding.error = 'Research budget elapsed; dedicated session stopped';
      await this.save(binding);
    });
  }
}
