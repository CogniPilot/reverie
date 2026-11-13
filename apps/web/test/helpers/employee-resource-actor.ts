/** Synthetic AF_UNIX physical port for real application/browser controls.
 * It is not a native controller, cgroup owner, process witness or enforcement proof.
 * No command/launch/engine verb is accepted. The real client must answer its
 * original owner challenge before this fixture returns resource DATA.
 */
import { createServer, type Socket } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
// These codecs import only wire DATA/Zod, not instance configuration.
import { EmployeePolicyEditApproval, EmployeeResourceStatus } from '../../src/resource-employee-data.js';

type Subject = { id: string; sessionId: string; sessionGeneration: number };
const Operation = z.union([
  z
    .object({
      kind: z.literal('resource-operation'),
      requestId: z.string().uuid(),
      verb: z.enum(['employee-status', 'employee-memory-diagnostics']),
      employeeId: z.string().uuid(),
      sessionId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('resource-operation'),
      requestId: z.string().uuid(),
      verb: z.literal('employee-policy-edit'),
      employeeId: z.string().uuid(),
      approval: EmployeePolicyEditApproval,
    })
    .strict(),
]);
type Operation = z.infer<typeof Operation>;
type EditOutcome = 'confirmed' | 'revision-refused' | 'commit-lost-reply';
const frame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4);
  if (body.length > 65536) throw new Error('Synthetic resource frame exceeded its bound');
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};

export async function createEmployeeResourceActor() {
  const root = await mkdtemp('/tmp/resource-browser-');
  await chmod(root, 0o700);
  const marker = randomUUID(),
    markerPath = join(root, 'fixture-owner');
  await writeFile(markerPath, marker, { mode: 0o600, flag: 'wx' });
  const socketPath = join(root, 'actor.sock'),
    peers = new Set<Socket>();
  let subject: Subject | undefined,
    revision = 1,
    memoryHighMiB = 8192,
    cpuWeight = 100;
  let outcome: EditOutcome = 'confirmed';
  const operations: Operation[] = [],
    proofs: Record<string, unknown>[] = [],
    failures: string[] = [];
  const digest = () => createHash('sha256').update(`synthetic-resource-revision:${revision}`).digest('hex');
  const snapshot = (): EmployeeResourceStatus => {
    if (!subject) throw new Error('The synthetic physical port has no selected subject');
    return EmployeeResourceStatus.parse({
      version: 1,
      employeeId: subject.id,
      sessionId: subject.sessionId,
      revision: digest(),
      state: 'running',
      requested: { memoryHighMiB, memoryMaxMiB: 49152, cpuWeight, allowedCpus: [0, 1], perfPolicy: 'off' },
      observed: {
        containerId: 'a'.repeat(64),
        pid: 4242,
        processStart: '1',
        leafDevice: '1',
        leafInode: '2',
        memoryHighBytes: String(memoryHighMiB * 1048576),
        memoryMaxBytes: '51539607552',
        memoryCurrentBytes: '1048576',
        memorySwapMaxBytes: '0',
        cpuWeight,
        cpuMax: 'max 100000',
        allowedCpus: [0, 1],
      },
      perfObserved: null,
      perfObservationReason: 'OWN_PROCESS_PROBE_REQUIRED',
      capabilities: {
        softMemoryLive: true,
        cpuWeightLive: true,
        hardMemoryReplacement: false,
        perfReplacement: false,
        gpuReplacement: false,
      },
      readOnly: true,
    });
  };
  const server = createServer((socket) => {
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    socket.on('error', () => {}); // Socket errors settle only this owned fixture connection.
    let buffer = Buffer.alloc(0),
      greeted = false;
    let original: Operation | undefined, nonce: string | undefined;
    const refuse = (reason: string) =>
      socket.write(frame({ kind: 'resource-refused', requestId: original!.requestId, reason }));
    const reply = (value: unknown) =>
      socket.write(frame({ kind: 'resource-result', requestId: original!.requestId, value }));
    const receive = (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid fixture resource frame');
      const value = raw as Record<string, unknown>;
      if (!original) {
        const operation = Operation.parse(value);
        if (
          !subject ||
          operation.employeeId !== subject.id ||
          (operation.verb !== 'employee-policy-edit' && operation.sessionId !== subject.sessionId)
        )
          throw new Error('The synthetic physical port refused an unexpected operation');
        original = operation;
        operations.push(original);
        nonce = randomUUID();
        socket.write(
          frame({
            kind: 'resource-owner-check',
            requestId: original.requestId,
            nonce,
            stage:
              original.verb === 'employee-policy-edit'
                ? 'employee-policy-edit'
                : original.verb === 'employee-memory-diagnostics'
                  ? 'employee-memory-diagnostics'
                  : 'status',
            employeeId: subject.id,
            approval: original.verb === 'employee-policy-edit' ? original.approval : null,
          })
        );
        return;
      }
      const stage =
        original.verb === 'employee-policy-edit'
          ? 'employee-policy-edit'
          : original.verb === 'employee-memory-diagnostics'
            ? 'employee-memory-diagnostics'
            : 'status';
      if (
        !nonce ||
        value.kind !== 'resource-owner-current' ||
        value.requestId !== original.requestId ||
        value.nonce !== nonce ||
        value.stage !== stage ||
        value.purpose !== 'resource-ram-pool-v2' ||
        !isDeepStrictEqual(value.approval, original.verb === 'employee-policy-edit' ? original.approval : null)
      )
        throw new Error('The real application did not answer the original owner challenge');
      nonce = undefined; // The same original proof cannot authorize a second fixture transition.
      proofs.push(structuredClone(value));
      if (original.verb === 'employee-memory-diagnostics') {
        refuse('RESOURCE_OPERATION_UNCONFIRMED_KEEP_CLAIM'); // Exercise the real independent-read fallback, never invent PSI.
      } else if (original.verb === 'employee-status') {
        reply(snapshot());
      } else if (original.verb === 'employee-policy-edit') {
        const approval = original.approval;
        if (!subject || approval.sessionId !== subject.sessionId) throw new Error('Foreign edit approval');
        if (outcome === 'revision-refused' || approval.expectedRevision !== digest()) {
          refuse('EMPLOYEE_RESOURCE_REVISION_CHANGED');
          return;
        }
        memoryHighMiB = approval.memoryHighMiB;
        cpuWeight = approval.cpuWeight;
        revision++;
        if (outcome === 'commit-lost-reply') {
          socket.destroy();
          return;
        }
        reply({
          version: 1,
          employeeId: subject.id,
          sessionId: subject.sessionId,
          operationId: approval.operationId,
          state: 'applied',
          memoryHighMiB,
          cpuWeight,
        });
      }
    };
    socket.on('data', (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 65541) throw new Error('Oversized fixture request');
        if (!greeted) {
          if (buffer.length < 5) return;
          const size = buffer.readUInt32BE(1);
          if (size > 65536 || buffer[0] !== 81) throw new Error('Wrong fixture protocol');
          if (buffer.length < size + 5) return;
          if (
            !isDeepStrictEqual(JSON.parse(buffer.subarray(5, 5 + size).toString()), {
              purpose: 'resource-ram-pool-v2',
              version: 2,
            })
          )
            throw new Error('Wrong fixture purpose');
          buffer = buffer.subarray(5 + size);
          greeted = true;
          socket.write('RESOURCE_READY\n');
        }
        while (buffer.length >= 4) {
          const size = buffer.readUInt32BE(0);
          if (!size || size > 65536) throw new Error('Invalid fixture frame size');
          if (buffer.length < size + 4) return;
          const raw: unknown = JSON.parse(buffer.subarray(4, 4 + size).toString());
          buffer = buffer.subarray(size + 4);
          receive(raw);
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'Unknown fixture parse failure');
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    operations,
    proofs,
    failures,
    select(value: Subject) {
      if (subject) throw new Error('The fixture subject is already selected');
      subject = Object.freeze({ ...value });
    },
    outcome(value: EditOutcome) {
      outcome = value;
    },
    snapshot,
    changeRevision() {
      revision++;
    },
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      if ((await readFile(markerPath, 'utf8')) !== marker) throw new Error('Fixture cleanup ownership changed');
      await rm(root, { recursive: true, force: true });
    },
  };
}
