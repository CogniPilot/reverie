/** Closed context DATA shared with the fixed worker-client plan installer.
 * This codec never supplies account, path, native observation or launch authority. */
import { z } from 'zod';
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((v) => BigInt(v) <= 18446744073709551615n);
const inode = decimal.refine((v) => v !== '0');
const component = z
  .string()
  .min(1)
  .refine(
    (v) =>
      Buffer.byteLength(v) <= 255 &&
      v !== '.' &&
      v !== '..' &&
      ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '/' || c === '\\')
  );
const relative = z
  .array(component)
  .min(1)
  .max(32)
  .refine((v) => v.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0) <= 4096);
export const DockerPlanSourceContext = z
  .object({
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }).strict(),
      z.object({ kind: z.literal('home'), relative, dev: decimal, ino: inode }).strict(),
      z.object({ kind: z.literal('intake'), dev: decimal, ino: inode }).strict(),
    ]),
    roles: z
      .array(
        z.enum(['claude-projects', 'claude-instructions', 'codex-sessions', 'codex-history', 'codex-instructions'])
      )
      .max(5),
    conversation: z
      .object({
        nativeId: z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
        relative,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    const bad = () => c.addIssue({ code: 'custom', message: 'Closed provider context required' });
    if (new Set(v.roles).size !== v.roles.length) bad();
    if (v.source.kind === 'none' && (v.roles.length || v.conversation !== null)) bad();
    const claude = v.roles.some((r) => r.startsWith('claude-'));
    const codex = v.roles.some((r) => r.startsWith('codex-'));
    if (claude && codex) bad();
    if (
      v.source.kind === 'intake' &&
      (v.roles.length !== 1 || !['claude-projects', 'codex-sessions'].includes(v.roles[0] ?? '') || !v.conversation)
    )
      bad();
    if (v.conversation) {
      const history = claude ? 'projects' : 'sessions',
        role = claude ? 'claude-projects' : 'codex-sessions';
      const name = v.conversation.relative.at(-1)!;
      if (
        !v.roles.includes(role) ||
        v.conversation.relative[0] !== history ||
        (claude
          ? name !== v.conversation.nativeId + '.jsonl'
          : !name.endsWith('-' + v.conversation.nativeId + '.jsonl'))
      )
        bad();
    }
  });
export type DockerPlanSourceContext = z.infer<typeof DockerPlanSourceContext>;
export function dockerPlanContextForProvider(
  value: unknown,
  provider: 'anthropic' | 'openai'
): DockerPlanSourceContext {
  const context = DockerPlanSourceContext.parse(value),
    prefix = provider === 'anthropic' ? 'claude-' : 'codex-';
  if (context.roles.some((r) => !r.startsWith(prefix))) throw Error('Context provider changed');
  return context;
}
