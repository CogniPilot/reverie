/** Explicit forced plan transfer; the normal server executor owns every effect. */
import { open, constants } from 'node:fs/promises';
import type { AgentDeps } from './cli-agent.js';
import { AGENT_EXIT as EXIT } from './agent-exit-codes.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const IDENTIFIER = /^[a-zA-Z0-9_-]{1,100}$/;
export async function agentForcePlanMove(
  deps: AgentDeps,
  options: {
    employeeId: string;
    accountId: string;
    id: string;
    handoffFile: string;
  }
): Promise<number> {
  const fail = (message: string, code: number = EXIT.error) => {
    deps.io.err(message);
    return code;
  };
  if (!UUID.test(options.employeeId) || !IDENTIFIER.test(options.accountId) || !IDENTIFIER.test(options.id))
    return fail('Use the full employee UUID, exact account ID and a stable operation ID.', EXIT.refused);
  let handoff: string;
  try {
    const file = await open(options.handoffFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.uid !== process.getuid?.() || before.size < 1 || before.size > 48_000)
        return fail('A bounded owned regular handoff file is required.', EXIT.refused);
      const bytes = Buffer.alloc(48_001);
      let length = 0;
      while (length < bytes.length) {
        const chunk = await file.read(bytes, length, bytes.length - length, null);
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      if (length > 48_000) return fail('The handoff file exceeds the supported bound.', EXIT.refused);
      handoff = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).trim();
      const after = await file.stat();
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        !handoff ||
        handoff.length > 12000 ||
        Array.from(handoff).some((character) => {
          const code = character.charCodeAt(0);
          return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
        })
      )
        return fail('The plain handoff changed or exceeds the supported bound.', EXIT.refused);
    } finally {
      await file.close();
    }
  } catch {
    return fail('The handoff file could not be read safely. Nothing was requested.', EXIT.refused);
  }
  let company;
  try {
    company = await deps.request(deps.ctx, { method: 'GET', path: '/api/company' });
  } catch {
    return fail('Current company bindings could not be read. Nothing was requested.');
  }
  const employees = (
    company.json?.data as
      | { employees?: Array<{ id?: unknown; sessionId?: unknown; sessionGeneration?: unknown }> }
      | undefined
  )?.employees;
  const matches = Array.isArray(employees) ? employees.filter((e) => e.id === options.employeeId) : [];
  const target = matches[0];
  if (
    !company.json?.success ||
    company.status !== 200 ||
    matches.length !== 1 ||
    typeof target?.sessionId !== 'string' ||
    !UUID.test(target.sessionId) ||
    !Number.isSafeInteger(target.sessionGeneration) ||
    Number(target.sessionGeneration) < 1
  )
    return fail(
      'A unique current employee/session/generation binding could not be confirmed. Nothing was requested.',
      EXIT.refused
    );
  let response;
  try {
    response = await deps.request(deps.ctx, {
      method: 'POST',
      path: '/api/plans/moves/force',
      body: {
        id: options.id,
        employeeId: options.employeeId,
        sessionId: target.sessionId,
        sessionGeneration: target.sessionGeneration,
        toAccount: options.accountId,
        handoff,
      },
    });
  } catch {
    return fail(
      'Forced transfer outcome is unconfirmed. It was not retried. Inspect the existing operation before another action.'
    );
  }
  if (!response.json?.success || response.status < 200 || response.status >= 300)
    return fail(
      'Forced transfer was refused or unconfirmed; existing delivery and stop fences remain authoritative.',
      [401, 403, 409].includes(response.status) ? EXIT.refused : EXIT.error
    );
  const record = response.json.data as
    | { id?: unknown; employeeId?: unknown; oldSession?: unknown; toAccount?: unknown; phase?: unknown }
    | undefined;
  if (
    record?.id !== options.id ||
    record.employeeId !== options.employeeId ||
    record.oldSession !== target.sessionId ||
    record.toAccount !== options.accountId ||
    typeof record.phase !== 'string'
  )
    return fail(
      'The forced transfer result does not confirm this operation and binding. Do not retry; inspect its status.'
    );
  if (deps.json) deps.io.out(JSON.stringify(record));
  else
    deps.io.out(
      `Forced transfer ${options.id}: ${record.phase}. Check its existing status and destination readiness; acknowledgement is not completion.`
    );
  return EXIT.ok;
}

/** Inspect/adopt/cancel only the existing journal. Never repeat a lost mutation. */
export async function agentMoveJournal(
  deps: AgentDeps,
  options: {
    employeeId: string;
    id: string;
    action: 'status' | 'resolve' | 'cancel';
  }
): Promise<number> {
  const fail = (message: string, code: number = EXIT.error) => {
    deps.io.err(message);
    return code;
  };
  if (!UUID.test(options.employeeId) || !IDENTIFIER.test(options.id))
    return fail('Use a full employee UUID and the exact existing operation ID.', EXIT.refused);
  const base = `/api/plans/moves/${options.id}`;
  const status = async () =>
    deps.request(deps.ctx, { method: 'POST', path: base + '/status', body: { employeeId: options.employeeId } });
  let response;
  try {
    response = await status();
  } catch {
    return fail('Existing move status could not be confirmed. No recovery action was requested.');
  }
  if (!response.json?.success || response.status < 200 || response.status >= 300)
    return fail(
      'Existing move status was refused; verify the current plan permission and native office connection.',
      [401, 403, 404, 409].includes(response.status) ? EXIT.refused : EXIT.error
    );
  const record = response.json.data as
    | {
        id?: unknown;
        employeeId?: unknown;
        oldSession?: unknown;
        newSession?: unknown;
        toAccount?: unknown;
        phase?: unknown;
      }
    | undefined;
  if (record?.id !== options.id || record.employeeId !== options.employeeId || typeof record.phase !== 'string')
    return fail('The status did not confirm the exact existing operation. Nothing was changed.');
  if (options.action !== 'status') {
    let body: Record<string, unknown> = { employeeId: options.employeeId };
    if (options.action === 'resolve') {
      if (
        record.phase !== 'recovery-required' ||
        typeof record.oldSession !== 'string' ||
        !UUID.test(record.oldSession) ||
        typeof record.newSession !== 'string' ||
        !UUID.test(record.newSession) ||
        typeof record.toAccount !== 'string' ||
        !IDENTIFIER.test(record.toAccount)
      )
        return fail(
          'Adoption requires a held journal with its exact existing source, destination and account. Nothing was changed.',
          EXIT.refused
        );
      body = {
        ...body,
        action: 'adopt-existing',
        oldSession: record.oldSession,
        newSession: record.newSession,
        toAccount: record.toAccount,
      };
    }
    try {
      response = await deps.request(deps.ctx, { method: 'POST', path: base + '/' + options.action, body });
    } catch {
      return fail(
        'Recovery outcome is unconfirmed. It was not retried; inspect the same operation ID before another action.'
      );
    }
    if (!response.json?.success || response.status < 200 || response.status >= 300)
      return fail(
        'Recovery was refused or unconfirmed. Existing stop/delivery holds remain authoritative.',
        [401, 403, 404, 409].includes(response.status) ? EXIT.refused : EXIT.error
      );
  }
  if (deps.json)
    deps.io.out(
      JSON.stringify({ data: response.json?.data, recovery: (response.json as { recovery?: unknown }).recovery })
    );
  else
    deps.io.out(
      `Existing move ${options.id}: ${options.action} acknowledged. Inspect its journal and actual destination; acknowledgement is not completion.`
    );
  return EXIT.ok;
}
