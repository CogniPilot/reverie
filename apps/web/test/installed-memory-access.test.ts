import { expect, it } from 'vitest';
import { InstalledMemoryScopeSchema } from '../src/installed-memory-context.js';
import { installedMemoryAccess } from '../src/installed-memory-access.js';
import { InstalledMemoryBridge } from '../src/installed-memory-bridge.js';
import { createMemoryTools } from '../src/mcp-memory-tools.js';
import type { ApiRequest } from '../src/cli-agent.js';

const context = InstalledMemoryScopeSchema.parse({
  instanceRef: 'existing-a',
  instanceId: 'default',
  fingerprint: 'a'.repeat(64),
  employee: {
    employeeId: 'employee-a',
    sessionId: '11111111-2222-4333-8444-555555555555',
    sessionGeneration: 3,
    ownerCodepoints: [55296],
  },
  resources: [
    { resourceId: 'private-a', scope: { kind: 'private' } },
    { resourceId: 'project-a', scope: { kind: 'project', project: 'project-a' } },
  ],
});
const reference = { grantId: 'grant-a', policyGeneration: `sha256:${'b'.repeat(64)}` };
const actor = { apiUrl: 'http://owned.test', selfId: context.employee.sessionId };
const reply = (project = false) => ({
  success: true,
  data: {
    instanceRef: context.instanceRef,
    instanceId: context.instanceId,
    resourceId: project ? 'project-a' : 'private-a',
    scope: project ? { kind: 'project', project: 'project-a' } : { kind: 'private' },
    grantRef: reference,
  },
});

it('selects only configured resources and pins the after-use grant generation without sending paths or programs', async () => {
  const calls: unknown[] = [];
  const controller = new AbortController();
  const request: ApiRequest = async (selected, options) => {
    expect(selected).toBe(actor);
    expect(options.signal).toBe(controller.signal);
    expect(options.bounds).toEqual({ maxBytes: 16384, deadlineMs: 20000 });
    calls.push(options.body);
    return { status: 200, json: reply(true), text: '' };
  };
  const check = installedMemoryAccess(context, actor, request);
  await expect(check('foreign')).rejects.toThrow('not configured');
  expect(calls).toEqual([]);
  const first = await check('project-a', undefined, controller.signal);
  await check('project-a', first, controller.signal);
  expect(calls).toEqual([
    { instanceRef: 'existing-a', resourceId: 'project-a', binding: context.employee },
    { instanceRef: 'existing-a', resourceId: 'project-a', binding: context.employee, expectedGrantRef: reference },
  ]);
});

it('refuses malformed, substituted, revoked and changed generation responses', async () => {
  const changed = [
    { status: 403, json: { success: false } },
    { status: 200, json: { ...reply(), extra: 'allow' } },
    ...[
      { instanceRef: 'existing-b' },
      { instanceId: 'renamed' },
      { resourceId: 'foreign' },
      { scope: { kind: 'project', project: 'foreign' } },
      { grantRef: { ...reference, policyGeneration: `sha256:${'c'.repeat(64)}` } },
      { grantRef: { ...reference, grantId: 'replacement' } },
    ].map((delta) => ({ status: 200, json: { success: true, data: { ...reply().data, ...delta } } })),
  ];
  for (const response of changed) {
    const request: ApiRequest = async () => ({ ...response, text: '' });
    await expect(installedMemoryAccess(context, actor, request)(undefined, reference)).rejects.toThrow();
  }
});

const executable = process.env.NIX_REVERIE_TEST_MEMORY_CLI;
it.skipIf(!executable)('withholds actual tool history if the post-read API check is revoked', async () => {
  // This is a consumer/data-release control using a genuinely checked package
  // origin. The recorded runner is not claimed to qualify installed DB/Office.
  const native = InstalledMemoryBridge.capture(executable!, {});
  let reads = 0;
  let checks = 0;
  const tools = createMemoryTools(
    { native, installed: context },
    async () => {
      reads++;
      return { stdout: '[{"text":"private history"}]', stderr: '', code: 0 };
    },
    undefined,
    async (_project, expected) => {
      if (++checks === 2) {
        expect(expected).toEqual(reference);
        throw new Error('revoked');
      }
      return reference;
    }
  );
  await expect(tools.run('memory_recall', { query: 'synthetic' })).rejects.toThrow('revoked');
  expect({ reads, checks }).toEqual({ reads: 1, checks: 2 });
  const denied = createMemoryTools({ native, installed: context }, async () => {
    reads++;
    return { stdout: '[]', stderr: '', code: 0 };
  });
  expect((await denied.run('memory_recall', { query: 'synthetic' })).isError).toBe(true);
  expect(reads).toBe(1);
});
