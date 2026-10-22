import fs from 'node:fs/promises';
import { writeCompanyStateFile } from './company-store.js';
import { BoardStateSchema, emptyBoard, type BoardState } from './board-types.js';

export class BoardError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/**
 * The board file (one per server). Writes go through one chain: copy, mutate, validate, run `beforeSave` (the audit
 * line), then commit atomically. Anything that throws leaves the board as it was.
 */
export class BoardStore {
  private state: BoardState = emptyBoard();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}

  async init(): Promise<void> {
    try {
      this.state = BoardStateSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  snapshot(): BoardState {
    return structuredClone(this.state);
  }

  update<T>(
    options: { ifRev?: number; beforeSave?: (next: BoardState) => Promise<void> },
    mutate: (state: BoardState) => T
  ): Promise<{ rev: number; result: T }> {
    const run = this.chain.then(async () => {
      if (options.ifRev !== undefined && options.ifRev !== this.state.rev) {
        throw new BoardError(`The board changed (rev ${this.state.rev}, you sent ${options.ifRev}); reload and try again`, 409);
      }
      const next = structuredClone(this.state);
      const result = mutate(next);
      next.rev = this.state.rev + 1;
      const checked = BoardStateSchema.safeParse(next);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        // A full list is refused, never trimmed to make room.
        const full = issue?.code === 'too_big';
        throw new BoardError(full ? `The board is full at ${issue.path.join('.')}; nothing was written` : `Invalid board change: ${issue?.path.join('.')}: ${issue?.message}`, full ? 409 : 400);
      }
      await options.beforeSave?.(next);
      await writeCompanyStateFile(this.file, JSON.stringify(next));
      this.state = next;
      return { rev: next.rev, result: structuredClone(result) };
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
