/** Executed-script identity comes from CDP contexts, never from network fetches. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CDPSession, Page } from 'playwright';

export const executionSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('attributed'),
      kind: z.enum(['main', 'iframe']),
      scriptId: z.string().min(1),
      sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      contextId: z.number().int().nonnegative(),
      generation: z.number().int().nonnegative(),
      frameId: z.string().min(1),
      mainFrameId: z.string().min(1),
      ancestry: z.array(z.string().min(1)).min(1),
    })
    .superRefine((value, context) => {
      if (
        value.ancestry[0] !== value.frameId ||
        value.ancestry.at(-1) !== value.mainFrameId ||
        new Set(value.ancestry).size !== value.ancestry.length ||
        (value.kind === 'main' ? value.ancestry.length !== 1 : value.ancestry.length < 2)
      )
        context.addIssue({
          code: 'custom',
          path: ['ancestry'],
          message: 'Execution proof lacks valid frame parentage',
        });
    }),
  z.object({ state: z.literal('unattributed'), reason: z.string().min(1) }),
]);
export type Execution = z.infer<typeof executionSchema>;
type Frame = { parent?: string; path: string };
type Context = { frameId?: string; uniqueId?: string; ancestry?: string[]; mainFrameId?: string };
type Script = {
  id: string;
  url: string;
  contextId: number;
  generation: number;
  sha256?: string;
  conflicting?: boolean;
};

export class ExecutionIndex {
  private readonly frames = new Map<string, Frame>();
  private readonly roots = new Set<string>();
  private readonly ambiguousFrames = new Set<string>();
  private readonly contexts = new Map<string, Context[]>();
  private readonly scripts = new Map<string, Script[]>();
  private readonly gaps = new Set<string>();
  private generation = 0;
  constructor(private readonly origin: string) {}
  frame(id: string, parent: string | undefined, url = '', root = false) {
    let path = 'opaque-or-external-frame';
    try {
      const parsed = new URL(url);
      if (parsed.origin === this.origin) path = parsed.pathname;
      else if (url === 'about:srcdoc' || url === 'about:blank') path = url;
    } catch {
      /* No raw opaque URL is retained. */
    }
    const previous = this.frames.get(id);
    if (previous?.parent && parent && previous.parent !== parent) {
      this.gaps.add('conflicting-frame-parentage');
      this.ambiguousFrames.add(id);
      return;
    }
    this.frames.set(id, { parent: parent || previous?.parent, path });
    if (root) this.roots.add(id);
  }
  swapped(id: string) {
    this.gaps.add(`out-of-process-frame-swap:${this.frames.get(id)?.path || 'unknown-frame'}`);
  }
  cleared() {
    this.generation++;
  }
  context(id: number, frameId?: string, uniqueId?: string) {
    const ancestry: string[] = [];
    if (frameId) {
      let current: string | undefined = frameId;
      while (current && !ancestry.includes(current)) {
        if (this.ambiguousFrames.has(current)) break;
        ancestry.push(current);
        if (this.roots.has(current)) break;
        current = this.frames.get(current)?.parent;
      }
    }
    const mainFrameId = ancestry.at(-1);
    const entry: Context = {
      frameId,
      uniqueId,
      ...(mainFrameId && this.roots.has(mainFrameId) ? { ancestry, mainFrameId } : {}),
    };
    const key = `${this.generation}:${id}`,
      values = this.contexts.get(key) || [];
    if (!values.some((value) => JSON.stringify(value) === JSON.stringify(entry))) values.push(entry);
    this.contexts.set(key, values);
  }
  script(id: string, url: string, contextId: number): Script {
    const record: Script = { id, url, contextId, generation: this.generation };
    const values = this.scripts.get(id) || [];
    const prior = values.find(
      (value) => value.url === url && value.contextId === contextId && value.generation === record.generation
    );
    if (prior) return prior;
    values.push(record);
    this.scripts.set(id, values);
    return record;
  }
  source(record: Script, sha256: string) {
    if (record.sha256 && record.sha256 !== sha256) record.conflicting = true;
    record.sha256 = sha256;
  }
  proof(id: string, url: string, sha256: string): Execution {
    const candidates = this.scripts.get(id) || [];
    if (candidates.length !== 1)
      return {
        state: 'unattributed',
        reason: candidates.length ? 'ambiguous-script-identity' : 'script-metadata-unavailable',
      };
    const script = candidates[0];
    if (script.conflicting) return { state: 'unattributed', reason: 'script-source-changed' };
    const sameLocation = (left: string, right: string) => {
      try {
        const a = new URL(left),
          b = new URL(right);
        return a.origin === this.origin && b.origin === this.origin && a.pathname === b.pathname;
      } catch {
        return false;
      }
    };
    if (!sameLocation(script.url, url) || script.sha256 !== sha256)
      return { state: 'unattributed', reason: 'script-source-identity-mismatch' };
    const contexts = this.contexts.get(`${script.generation}:${script.contextId}`) || [];
    if (contexts.length !== 1) return { state: 'unattributed', reason: 'ambiguous-or-missing-execution-context' };
    const context = contexts[0];
    if (!context.frameId || !context.ancestry || !context.mainFrameId)
      return { state: 'unattributed', reason: 'frame-parentage-unavailable' };
    return {
      state: 'attributed',
      kind: context.ancestry.length === 1 ? 'main' : 'iframe',
      scriptId: id,
      sourceSha256: sha256,
      contextId: script.contextId,
      generation: script.generation,
      frameId: context.frameId,
      mainFrameId: context.mainFrameId,
      ancestry: [...context.ancestry],
    };
  }
  collectionGaps() {
    return [...this.gaps];
  }
}

const frameSchema = z.object({
  frame: z.object({ id: z.string(), parentId: z.string().optional(), url: z.string() }),
  childFrames: z.array(z.unknown()).optional(),
});
const contextSchema = z.object({
  context: z.object({
    id: z.number().int(),
    uniqueId: z.string().optional(),
    auxData: z.object({ frameId: z.string().optional() }).optional(),
  }),
});
const scriptSchema = z.object({ scriptId: z.string(), url: z.string(), executionContextId: z.number().int() });

export class ExecutionTracker {
  private readonly pending = new Set<Promise<void>>();
  private accepting = true;
  private sealed: Promise<ExecutionIndex> | undefined;
  private constructor(
    private readonly session: CDPSession,
    readonly index: ExecutionIndex
  ) {}
  static async attach(page: Page, origin: string): Promise<ExecutionTracker> {
    const session = await page.context().newCDPSession(page),
      tracker = new ExecutionTracker(session, new ExecutionIndex(origin));
    session.on('Page.frameAttached', (event: unknown) => {
      const parsed = z.object({ frameId: z.string(), parentFrameId: z.string() }).safeParse(event);
      if (parsed.success) tracker.index.frame(parsed.data.frameId, parsed.data.parentFrameId);
    });
    session.on('Page.frameNavigated', (event: unknown) => {
      const parsed = z.object({ frame: frameSchema.shape.frame }).safeParse(event);
      if (parsed.success) tracker.index.frame(parsed.data.frame.id, parsed.data.frame.parentId, parsed.data.frame.url);
    });
    session.on('Page.frameDetached', (event: unknown) => {
      const parsed = z.object({ frameId: z.string(), reason: z.string() }).safeParse(event);
      if (parsed.success && parsed.data.reason === 'swap') tracker.index.swapped(parsed.data.frameId);
    });
    session.on('Runtime.executionContextsCleared', () => tracker.index.cleared());
    session.on('Runtime.executionContextCreated', (event: unknown) => {
      const parsed = contextSchema.safeParse(event);
      if (parsed.success) {
        const context = parsed.data.context;
        tracker.index.context(context.id, context.auxData?.frameId, context.uniqueId);
      }
    });
    session.on('Debugger.scriptParsed', (event: unknown) => {
      if (!tracker.accepting) return;
      const parsed = scriptSchema.safeParse(event);
      if (!parsed.success) return;
      const { scriptId, url, executionContextId } = parsed.data;
      try {
        if (new URL(url).origin !== origin) return;
      } catch {
        return;
      }
      const record = tracker.index.script(scriptId, url, executionContextId);
      const pending = session
        .send('Debugger.getScriptSource', { scriptId })
        .then((source: unknown) => {
          const value = z.object({ scriptSource: z.string() }).parse(source);
          tracker.index.source(record, createHash('sha256').update(value.scriptSource).digest('hex'));
        })
        .catch(() => {
          /* Unavailable bytes never qualify a proof. */
        });
      tracker.pending.add(pending);
      void pending.finally(() => tracker.pending.delete(pending));
    });
    try {
      await session.send('Page.enable');
      const tree: unknown = await session.send('Page.getFrameTree');
      const root = z.object({ frameTree: z.unknown() }).parse(tree).frameTree;
      const visit = (input: unknown, parent?: string) => {
        const node = frameSchema.parse(input);
        tracker.index.frame(node.frame.id, parent || node.frame.parentId, node.frame.url, parent === undefined);
        for (const child of node.childFrames || []) visit(child, node.frame.id);
      };
      visit(root);
      await session.send('Runtime.enable');
      await session.send('Debugger.enable');
      await session.send('Debugger.setSkipAllPauses', { skip: true });
      return tracker;
    } catch (error) {
      await session.detach();
      throw error;
    }
  }
  seal(): Promise<ExecutionIndex> {
    this.sealed ??= this.capture();
    return this.sealed;
  }
  private async capture() {
    this.accepting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.pending]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Execution metadata source capture exceeded 5 s')), 5_000);
        }),
      ]);
      return this.index;
    } finally {
      if (timer) clearTimeout(timer);
      await this.session.detach();
    }
  }
}
