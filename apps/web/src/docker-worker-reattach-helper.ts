/** Transport for the pinned Rust verifier. It does not hold recovery state. */
import { isDeepStrictEqual } from 'node:util';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { DockerEmployeeInspect } from './docker-employee-engine-data.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import { parseBoxedConfigurationJson } from './docker-employee-policy-import.js';

type Directory = Readonly<{ dev: string; ino: string; uid: number; gid: number; mode: number }>;
type Issuer = () => Readonly<{ instanceId: string; key: string }>;

const executable = '/bin/reverie-docker-resources';
const refuse = (): never => {
  throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_REATTACH_VERIFIER_UNCONFIRMED');
};

export class DockerWorkerReattachHelper {
  constructor(
    private readonly command: DockerEngineCommand,
    private readonly imageId: string,
    private readonly issuer: Issuer
  ) {}

  async #verify(args: string[], user: string, mounts: string[], current: () => void, input?: string): Promise<unknown> {
    current();
    if (!/^sha256:[0-9a-f]{64}$/.test(this.imageId) || !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/.test(user))
      return refuse();
    const raw = await this.command.run(['image', 'inspect', '--format', '{{json .Id}}', this.imageId]);
    current();
    if (raw.trim() !== JSON.stringify(this.imageId)) return refuse();
    let output: string;
    try {
      output = await this.command.run([
        'run', '--rm', '--pull=never', '--read-only', '--network=none', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--memory=32m', '--memory-swap=32m', '--pids-limit=8',
        '--log-driver=none', '--user', user, '--entrypoint', executable,
        ...(input === undefined ? [] : ['--interactive']),
        ...mounts, this.imageId, ...args,
      ], input, 15_000);
    } catch {
      // Limit diagnostics to the operation. Never surface subprocess details or input.
      return refuse();
    }
    current();
    if (Buffer.byteLength(output) > 2048) return refuse();
    return parseBoxedConfigurationJson(output);
  }

  storage(
    destination: DockerEmployeeInspect,
    seen: Readonly<{ home: Directory; nix: Directory }>,
    current: () => void
  ): Promise<unknown> {
    const bind = (guest: string, target: string) => {
      const mounts = destination.Mounts.filter(mount => mount.Destination === guest);
      const mount = mounts[0];
      if (mounts.length !== 1 || !mount || mount.Type !== 'bind' || !mount.Source.startsWith('/') ||
        mount.Source === '/') return refuse();
      if (Array.from(mount.Source).some((character) =>
        character === ',' || character === '"' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )) return refuse();
      return ['--mount', 'type=bind,source=' + mount.Source + ',target=' + target + ',readonly'];
    };
    const expected = (value: Directory) => [value.dev, value.ino, value.uid, value.gid, value.mode].join(':');
    return this.#verify(
      ['verify-storage-reference', '--home', expected(seen.home), '--nix', expected(seen.nix)],
      destination.Config.User,
      [...bind('/home/agent', '/run/reverie-worker-home'), ...bind('/nix', '/run/reverie-worker-nix')],
      current
    );
  }

  async credential(row: DockerEmployeeContinuationRecord, observedTokenDigest: string, current: () => void): Promise<void> {
    current();
    if (!row.destination || !/^[0-9a-f]{64}$/.test(observedTokenDigest)) return refuse();
    const binding = {
      employeeId: row.employeeId,
      sessionId: row.request.sessionId,
      sessionGeneration: row.request.sessionGeneration,
      owner: row.owner ?? null,
      containerId: row.destination.containerId,
      credentialId: row.credentialId,
    };
    const receipt = await this.#verify(['verify-worker-credential'], '65534:65534', [], current, JSON.stringify({
      version: 1,
      purpose: 'reverie-boxed-worker-credential-check-v1',
      binding,
      observedTokenDigest,
      issuer: { version: 1, purpose: 'reverie-docker-worker-key-v1', ...this.issuer() },
    }));
    current();
    if (!isDeepStrictEqual(receipt, { version: 1, purpose: 'reverie-boxed-worker-credential-verified-v1', binding }))
      return refuse();
  }
}
