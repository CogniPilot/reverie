/**
 * @fileoverview Who besides the owner may author scheduled post jobs ("routines").
 *
 * The permission belongs to a ROLE (an employee's position), with per-employee overrides the owner sets. Shipped
 * defaults name roles only, never people: 'CTO' and 'COO' have it, every other role needs an owner grant.
 * Only the owner changes this file. A delegate may create, edit, enable, run and delete post jobs; bots, their room
 * allowlists and their hourly caps stay owner-only (see chat-bot-routes.ts). The grants are instance data.
 */
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_ROUTINE_ROLES = ['CTO', 'COO'];

export interface RoutinesGrantsState {
  /** Positions that hold the permission by default. */
  roles: string[];
  /** Employee id -> true (grant) or false (deny), overriding the role. */
  employees: Record<string, boolean>;
}

export class RoutinesGrantsError extends Error {}

const norm = (s: string): string => s.trim().toLowerCase();

export class RoutinesGrants {
  private state: RoutinesGrantsState = { roles: [...DEFAULT_ROUTINE_ROLES], employees: {} };
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    try {
      this.state = RoutinesGrants.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** A stored or submitted state, or a RoutinesGrantsError saying what is wrong. */
  static parse(raw: unknown): RoutinesGrantsState {
    const o = (raw ?? {}) as Record<string, unknown>;
    const roles = o.roles ?? DEFAULT_ROUTINE_ROLES;
    const employees = o.employees ?? {};
    if (!Array.isArray(roles) || roles.length > 20 || roles.some((r) => typeof r !== 'string' || !r.trim() || r.length > 100)) {
      throw new RoutinesGrantsError('roles must be up to 20 non-empty names');
    }
    if (typeof employees !== 'object' || employees === null || Array.isArray(employees)) {
      throw new RoutinesGrantsError('employees must map an employee id to true or false');
    }
    const entries = Object.entries(employees as Record<string, unknown>);
    if (entries.length > 200 || entries.some(([, v]) => typeof v !== 'boolean')) {
      throw new RoutinesGrantsError('employees must map an employee id to true or false');
    }
    return { roles: [...new Set((roles as string[]).map((r) => r.trim()))], employees: Object.fromEntries(entries) as Record<string, boolean> };
  }

  snapshot(): RoutinesGrantsState {
    return structuredClone(this.state);
  }

  /** An override wins over the role; an employee with neither has no permission. */
  allows(employee: { id: string; position: string }): boolean {
    const override = this.state.employees[employee.id];
    if (override !== undefined) return override;
    return this.state.roles.some((r) => norm(r) === norm(employee.position));
  }

  set(raw: unknown): Promise<RoutinesGrantsState> {
    const next = RoutinesGrants.parse(raw);
    const run = this.chain.then(async () => {
      await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
        await fs.rename(tmp, this.file);
      } finally {
        await fs.rm(tmp, { force: true });
      }
      this.state = next;
      return this.snapshot();
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
