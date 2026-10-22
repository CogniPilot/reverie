import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CompanyStateSchema, type CompanyState } from './company-types.js';

/** Commit sensitive state and launch intent across process crashes and power loss. */
export async function writeCompanyStateFile(file: string, data: string): Promise<void> {
  const directory = dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const parent = await fs.open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** One writer per instance. Durable intent is committed before starting any agent work. */
export class CompanyStore {
  private state: CompanyState = {
    version: 1,
    employees: [],
    settings: [],
    cycles: [],
    memories: [],
    temporaryAgents: [],
    retired: [],
  };
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}

  async init(): Promise<void> {
    try {
      this.state = CompanyStateSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  snapshot(): CompanyState {
    return structuredClone(this.state);
  }

  update<T>(mutate: (state: CompanyState) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const next = structuredClone(this.state);
      const result = mutate(next);
      CompanyStateSchema.parse(next);
      await writeCompanyStateFile(this.file, JSON.stringify(next));
      this.state = next;
      return structuredClone(result);
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
