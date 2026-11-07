/** Owns a real unprivileged user/mount/PID namespace for installed-context reads.
 * This is test isolation, not a bootstrap/mount API or production permission.
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BridgeRunner } from '../../src/mcp-memory-tools.js';
import type { MemoryInstallationData } from '../../src/memory-scope-config.js';
import type { InstalledMemoryScope } from '../../src/installed-memory-context.js';
import { DatabaseSync } from 'node:sqlite';

export const NAMESPACE_SETTINGS = Object.freeze({
  HOME: '/home/test',
  REVERIE_ROOT: '/home/test/.reverie',
  REVERIE_EMBED_DIMS: '8',
  REVERIE_API_BASE: 'http://127.0.0.1:0',
  REVERIE_EMBED_URL: 'http://127.0.0.1:0',
  REVERIE_EMBED_QUERY_PREFIX: 'chosen-query: ',
  REVERIE_EMBED_DOC_PREFIX: 'chosen-document: ',
});
export const NAMESPACE_HISTORY =
  'Synthetic namespace history keeps its existing data and unrelated legacy employee UUID.';

export class InstalledMemoryNamespace {
  private output = Buffer.alloc(0);
  private diagnostic = '';
  private used = false;
  private readonly closed: Promise<number | null>;
  private readonly timer: ReturnType<typeof setTimeout>;
  private constructor(
    readonly root: string,
    readonly context: InstalledMemoryScope,
    private readonly program: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly guestConfiguration: string
  ) {
    child.stdout.on('data', (data) => {
      this.output = Buffer.concat([this.output, data]);
    });
    child.stderr.on('data', (data) => {
      this.diagnostic += String(data);
    });
    child.stdin.on('error', () => {});
    this.closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(this.timer);
        resolve(code);
      });
    });
    this.timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  }

  static async prepare(
    parent: string,
    program: string,
    installation: MemoryInstallationData,
    employee: InstalledMemoryScope['employee']
  ): Promise<InstalledMemoryNamespace> {
    const root = join(parent, 'installed-namespace');
    await mkdir(root);
    for (const path of ['bin', 'nix/store', 'proc', 'run/reverie', 'home/test/.reverie', 'etc', 'tmp'])
      await mkdir(join(root, path), { recursive: true });
    const guestConfiguration = installation.guestConfigPathCodepoints
      .map((point) => String.fromCodePoint(point))
      .join('');
    const configuration = join(root, guestConfiguration);
    await mkdir(dirname(configuration), { recursive: true });
    await copyFile(program, join(root, 'bin/reverie-memory'));
    await chmod(join(root, 'bin/reverie-memory'), 0o555);
    await writeFile(join(root, 'etc/passwd'), 'root:x:0:0:Synthetic namespace account:/home/test:/bin/sh\n');
    await writeFile(join(root, 'etc/group'), 'root:x:0:\n');
    await writeFile(join(root, 'etc/nsswitch.conf'), 'passwd: files\ngroup: files\nhosts: files\n');
    await writeFile(
      configuration,
      JSON.stringify({
        id: installation.instanceId,
        employee_id: '33333333-3333-4333-8333-333333333333',
        agent_name: 'Synthetic employee',
        owner_name: 'Synthetic owner',
        data_dir: 'state',
        persona: 'Synthetic namespace persona.',
      })
    );
    const resources = installation.resources.map((row) => ({ resourceId: row.resourceId, scope: row.scope }));
    const raw = JSON.stringify({
      schema: 'reverie-installed-memory-context-v1',
      instanceRef: installation.instanceRef,
      instanceId: installation.instanceId,
      employee,
      configPathCodepoints: installation.guestConfigPathCodepoints,
      resources,
    });
    const fingerprint = createHash('sha256').update(raw).digest('hex');
    await writeFile(join(root, 'run/reverie/memory-context.json'), raw, { mode: 0o444 });
    const fixture = join(parent, 'namespace-fixture');
    execFileSync('rustc', [
      '--edition=2024',
      fileURLToPath(new URL('../fixtures/memory-installed-namespace.rs', import.meta.url)),
      '-o',
      fixture,
    ]);
    const child = spawn(
      'unshare',
      [
        '--user',
        '--map-root-user',
        '--mount',
        '--propagation',
        'private',
        '--pid',
        '--fork',
        '--kill-child=SIGKILL',
        `--mount-proc=${join(root, 'proc')}`,
        fixture,
        root,
        guestConfiguration,
        fingerprint,
      ],
      { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const owned = new InstalledMemoryNamespace(
      root,
      { instanceRef: installation.instanceRef, instanceId: installation.instanceId, employee, resources, fingerprint },
      program,
      child,
      guestConfiguration
    );
    try {
      await owned.ready();
      return owned;
    } catch (error) {
      await owned.close();
      throw error;
    }
  }

  private async ready(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (this.output.subarray(0, 6).toString() === 'READY\n') return;
      if (this.child.exitCode !== null || this.child.signalCode !== null)
        throw new Error(`Owned namespace setup failed: ${this.diagnostic}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Owned namespace did not finish explicit fixture startup');
  }

  async snapshot(): Promise<Buffer[]> {
    const directory = join(this.root, dirname(this.guestConfiguration), 'state');
    return Promise.all([
      readFile(join(directory, 'memory.sqlite')),
      readFile(join(directory, 'profile.md')),
      readFile(join(this.root, this.guestConfiguration)),
    ]);
  }

  seedExistingHistory(): void {
    // Synthetic preexisting SQLite data, not a production model/provider stub.
    // Zero vectors are accepted legacy BLOB values and must remain untouched.
    const database = new DatabaseSync(join(this.root, dirname(this.guestConfiguration), 'state/memory.sqlite'));
    try {
      const model = database.prepare("SELECT value FROM state WHERE key='native_memory_embed_model_v1'").get() as {
        value: string;
      };
      database
        .prepare('INSERT INTO memories(kind,created_at,text,importance,embed_model,embedding) VALUES (?,?,?,?,?,?)')
        .run('episode', Date.now() / 1000, NAMESPACE_HISTORY, 3, model.value, Buffer.alloc(8 * 4));
    } finally {
      database.close();
    }
  }

  invocationCount(): number {
    return this.used ? 1 : 0;
  }

  readonly run: BridgeRunner = async (program, args, options) => {
    if (
      this.used ||
      program !== this.program ||
      JSON.stringify(args) !== JSON.stringify(['--installed-context', '--expected-context', this.context.fingerprint])
    )
      throw new Error('Unexpected native context invocation');
    this.used = true;
    for (const [key, value] of Object.entries(NAMESPACE_SETTINGS))
      if (options.env[key] !== value) throw new Error(`Selected memory setting changed: ${key}`);
    for (const key of [
      'REVERIE_USERNAME',
      'REVERIE_PASSWORD',
      'REVERIE_API_URL',
      'REVERIE_SESSION_ID',
      'REVERIE_MUX',
      'PYTHONPATH',
    ])
      if (options.env[key] !== undefined) throw new Error(`Credential/identity leaked into test child: ${key}`);
    const abort = () => this.child.kill('SIGKILL');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      this.child.stdin.end(options.input);
      const status = await this.closed;
      if (status !== 0) throw new Error(`Owned namespace failed (${status}): ${this.diagnostic}`);
      const end = this.output.indexOf(10, 6);
      const header = this.output
        .subarray(6, end)
        .toString()
        .match(/^RESULT (\d+) (\d+) (\d+)$/);
      if (!header) throw new Error('Missing actual native result frame');
      const size = Number(header[2]),
        errorSize = Number(header[3]);
      const body = this.output.subarray(end + 1);
      if (body.length !== size + errorSize) throw new Error('Truncated actual native result');
      return {
        code: Number(header[1]),
        stdout: body.subarray(0, size).toString(),
        stderr: body.subarray(size).toString(),
      };
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  };

  async close(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.closed;
  }
}
