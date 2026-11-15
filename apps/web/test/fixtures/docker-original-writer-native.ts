/** Explicit isolated historical-helper acceptance: no company, paid provider,
 * current pool, personal mounts or resource writes. Never part of normal boot. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { dockerContinuationDigest } from '../../src/docker-employee-continuation.js';
import type { DockerContinuationTask } from '../../src/docker-continuation-task.js';
import {
  dockerResourceHelperConfiguration,
  requireDockerResourceHelperConfiguration,
} from '../../src/docker-resource-helper-inspection.js';
import {
  DockerOriginalResourceWriterReader,
  requireDockerOriginalResourceWriterProof,
  type DockerOriginalResourceWriterKey,
} from '../../src/docker-resource-original-writer.js';

type Config = Readonly<Record<string, unknown>>;
type Row = {
  Id: string;
  Name: string;
  Image: string;
  State: { Status: string; Running: boolean; Pid: number; ExitCode: number };
} & Record<string, unknown>;
type Owned = { id: string; name: string; config: Config; init?: { pid: number; start: string } };
class NativeReaderFixture {
  readonly box = randomBytes(32).toString('hex');
  readonly owned: Owned[] = [];
  readonly readerCalls: string[][] = [];
  readonly directory: number;
  serial = 0;
  constructor(
    readonly output: string,
    readonly baseline: string,
    readonly writer: string
  ) {
    assert.ok(isAbsolute(output));
    for (const image of [baseline, writer]) assert.match(image, /^sha256:[a-f0-9]{64}$/u);
    assert.notEqual(baseline, writer);
    fs.mkdirSync(output, { mode: 0o700 });
    this.directory = fs.openSync(output, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    assert.equal(fs.fstatSync(this.directory).uid, process.getuid?.());
    this.save('plan', {
      box: this.box,
      baseline,
      writer,
      noCompanyData: true,
      noProvider: true,
      noResourceWrites: true,
    });
  }
  save(name: string, value: unknown): void {
    const fd = fs.openSync(join(this.output, name + '.json'), 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.fsyncSync(this.directory);
  }
  run(args: readonly string[]): string {
    const name = String(++this.serial).padStart(3, '0');
    this.save(name + '-intent', { args });
    const r = spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: this.output, DOCKER_CONFIG: this.output, LANG: 'C.UTF-8' },
    });
    this.save(name + '-result', {
      status: r.status,
      signal: r.signal,
      error: r.error?.message,
      stdout: r.stdout,
      stderr: r.stderr,
    });
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }
  inspect(id: string): Row {
    const rows = JSON.parse(this.run(['container', 'inspect', id])) as Row[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.Id, id);
    return rows[0]!;
  }
  birth(row: Row): string {
    assert.equal(row.State.Running, true);
    assert.ok(row.State.Pid > 1);
    const stat = fs.readFileSync(`/proc/${row.State.Pid}/stat`, 'utf8');
    assert.ok(stat.length < 4096);
    const fields = stat
      .slice(stat.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/u);
    assert.match(fields[19]!, /^[1-9][0-9]*$/u);
    return fields[19]!;
  }
  async create(name: string, config: Config): Promise<Owned> {
    this.save('create-' + name, { name, config });
    const body = JSON.stringify(config);
    const result = await new Promise<string>((resolve, reject) => {
      const call = request(
        {
          socketPath: '/var/run/docker.sock',
          method: 'POST',
          path: '/v1.45/containers/create?name=' + encodeURIComponent(name),
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            text += chunk;
            if (text.length > 65536) call.destroy(Error('Create reply bound'));
          });
          response.on('error', reject);
          response.on('aborted', () => reject(Error('Create reply unknown')));
          response.on('end', () => {
            if (!response.complete || response.statusCode !== 201) {
              reject(Error('Create reply unconfirmed: ' + response.statusCode));
              return;
            }
            try {
              const id = (JSON.parse(text) as { Id: string }).Id;
              assert.match(id, /^[a-f0-9]{64}$/u);
              resolve(id);
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      call.setTimeout(30000, () => call.destroy(Error('Create deadline')));
      call.on('error', reject);
      call.end(body);
    });
    this.save('created-' + name, { id: result, name, config });
    const owned: Owned = { id: result, name, config };
    this.owned.push(owned);
    const raw = this.inspect(result);
    this.fixed(raw, owned);
    assert.equal(raw.State.Status, 'created');
    assert.equal(raw.State.Pid, 0);
    return owned;
  }
  fixed(raw: Row, owned: Owned) {
    assert.equal(raw.Id, owned.id);
    assert.equal(raw.Name, '/' + owned.name);
    requireDockerResourceHelperConfiguration(raw, owned.config);
  }
  reader() {
    return new DockerOriginalResourceWriterReader({
      run: async (args) => {
        assert.ok(args[1] === 'inspect' && ['container', 'image'].includes(args[0]!));
        this.readerCalls.push([...args]);
        return this.run(args);
      },
    });
  }
  async accept() {
    const baselineBefore = JSON.parse(this.run(['image', 'inspect', this.baseline])) as unknown;
    const anchorName = 'reverie-boxed-anchor-' + this.box.slice(0, 32);
    const anchor = await this.create(
      anchorName,
      dockerResourceHelperConfiguration(this.box, 'anchor', anchorName, ['anchor'], undefined, this.baseline)
    );
    this.save('anchor-start-issued', { id: anchor.id });
    this.run(['start', anchor.id]);
    const anchorRunning = this.inspect(anchor.id);
    anchor.init = { pid: anchorRunning.State.Pid, start: this.birth(anchorRunning) };
    const workerName = 'reverie-boxed-anchor-' + dockerContinuationDigest([this.box, 'worker']).slice(0, 32);
    const worker = await this.create(
      workerName,
      dockerResourceHelperConfiguration(this.box, 'anchor', workerName, ['anchor'], undefined, this.baseline)
    );
    this.save('worker-start-issued', { id: worker.id });
    this.run(['start', worker.id]);
    const running = this.inspect(worker.id);
    worker.init = { pid: running.State.Pid, start: this.birth(running) };
    const probeWorker = () =>
      JSON.parse(
        this.run([
          'exec',
          anchor.id,
          '/bin/reverie-docker-resources',
          'probe-worker',
          '--box-id',
          this.box,
          '--anchor-id',
          anchor.id,
          '--anchor-pid',
          String(anchor.init!.pid),
          '--anchor-start',
          anchor.init!.start,
          '--worker-id',
          worker.id,
          '--worker-pid',
          String(worker.init!.pid),
          '--worker-start',
          worker.init!.start,
        ])
      ) as { worker: { dev: string; ino: string; startTicks: string; path: string } };
    const probe = probeWorker();
    assert.equal(probe.worker.startTicks, worker.init.start);
    const key: DockerOriginalResourceWriterKey = {
      revision: randomUUID(),
      scopeDigest: randomBytes(32).toString('hex'),
      employeeId: randomUUID(),
      sessionId: randomUUID(),
      sessionGeneration: 1,
      operationId: randomUUID(),
      containerId: worker.id,
    };
    const name =
      'reverie-boxed-leaf-helper-' + dockerContinuationDigest([this.box, 'leaf-helper', key.operationId, key.revision]);
    const args = [
      'configure-memory-high',
      '--box-id',
      this.box,
      '--anchor-id',
      anchor.id,
      '--anchor-pid',
      String(anchor.init.pid),
      '--anchor-start',
      anchor.init.start,
      '--worker-id',
      worker.id,
      '--worker-pid',
      String(worker.init.pid),
      '--worker-start',
      worker.init.start,
      '--leaf-dev',
      probe.worker.dev,
      '--leaf-ino',
      probe.worker.ino,
      '--memory-max',
      '268435456',
      '--swap-max',
      '0',
      '--pids-max',
      '32',
      '--memory-high',
      '16777216',
      '--cpu-weight',
      '100',
      '--cpuset-cpus',
      '0',
    ];
    const config = dockerResourceHelperConfiguration(
      this.box,
      'leaf-helper',
      name,
      args,
      { path: probe.worker.path, target: '/run/reverie-worker-cgroup' },
      this.writer
    );
    const issued = await this.create(name, config);
    const task: DockerContinuationTask = {
      role: 'leaf-helper',
      name,
      imageId: this.writer,
      configurationDigest: dockerContinuationDigest(config),
      phase: 'start-issued',
      containerId: issued.id,
    };
    const nativeBefore = probeWorker();
    this.save('original-issued-cursor', { key, task });
    await assert.rejects(
      this.reader().capture(key, task, () => {}),
      'Actual CREATED does not close a writer'
    );
    this.run(['start', issued.id]);
    assert.notEqual(Number(this.run(['wait', issued.id]).trim()), 0, 'Hard-limit mismatch must refuse before writing');
    const helper = this.inspect(issued.id);
    assert.equal(helper.State.Status, 'exited');
    assert.equal(helper.State.Pid, 0);
    assert.equal(this.run(['logs', issued.id]).trim(), '', 'No resource observation ACK on refusal');
    const nativeAfter = probeWorker();
    assert.deepEqual(nativeAfter, nativeBefore);
    this.save('native-refusal', { exitCode: helper.State.ExitCode, noResourceAck: true, nativeBefore, nativeAfter });
    // Mutated native configurations stay CREATED. They are never STARTed.
    for (const mutation of ['labels', 'restart', 'config', 'image'] as const) {
      const otherKey = { ...key, revision: randomUUID() };
      const otherName =
        'reverie-boxed-leaf-helper-' +
        dockerContinuationDigest([this.box, 'leaf-helper', otherKey.operationId, otherKey.revision]);
      const expected = dockerResourceHelperConfiguration(
        this.box,
        'leaf-helper',
        otherName,
        args,
        { path: probe.worker.path, target: '/run/reverie-worker-cgroup' },
        this.writer
      );
      const wrong = structuredClone(expected);
      if (mutation === 'labels') (wrong.Labels as Record<string, string>)['reverie.box.resource.role'] = 'pool-helper';
      if (mutation === 'restart')
        (wrong.HostConfig as Record<string, unknown>).RestartPolicy = { Name: 'always', MaximumRetryCount: 0 };
      if (mutation === 'config')
        (wrong.Cmd as string[])[(wrong.Cmd as string[]).indexOf('--memory-high') + 1] = '33554432';
      if (mutation === 'image') (wrong as Record<string, unknown>).Image = this.baseline;
      const invalid = await this.create(otherName, wrong);
      const wrongTask: DockerContinuationTask = {
        ...task,
        name: otherName,
        containerId: invalid.id,
        configurationDigest: dockerContinuationDigest(expected),
      };
      await assert.rejects(this.reader().capture(otherKey, wrongTask, () => {}));
      this.save('native-refused-' + mutation, { containerId: invalid.id, neverStarted: true });
    }
    this.fixed(this.inspect(worker.id), worker);
    assert.equal(this.birth(this.inspect(worker.id)), worker.init.start);
    this.save('worker-stop-issued', worker.init);
    this.run(['stop', '--time', '3', worker.id]);
    const stopped = this.inspect(worker.id);
    assert.equal(stopped.State.Status, 'exited');
    assert.equal(stopped.State.Pid, 0);
    const proof = await this.reader().capture(key, task, () => {});
    const receipt = requireDockerOriginalResourceWriterProof(proof, key, task);
    assert.equal(receipt.originalOutcome, 'unknown');
    assert.equal(receipt.containerId, issued.id);
    assert.equal('identity' in receipt, false);
    assert.equal('policy' in receipt, false);
    this.save('native-reader-accepted', {
      key,
      task,
      workerStopped: stopped.State,
      receipt,
      readerCalls: this.readerCalls,
    });
    assert.deepEqual(JSON.parse(this.run(['image', 'inspect', this.baseline])), baselineBefore);
    this.save('baseline-unchanged', { imageId: this.baseline, equal: true });
  }
  cleanup() {
    for (const owned of [...this.owned].reverse()) {
      const raw = this.inspect(owned.id);
      this.fixed(raw, owned);
      if (raw.State.Running) {
        assert.ok(owned.init, 'Unknown helper incarnation retained');
        assert.equal(raw.State.Pid, owned.init.pid);
        assert.equal(this.birth(raw), owned.init.start);
        this.run(['stop', '--time', '3', owned.id]);
      }
      const terminal = this.inspect(owned.id);
      this.fixed(terminal, owned);
      assert.equal(terminal.State.Running, false);
      assert.equal(terminal.State.Pid, 0);
      assert.ok(['created', 'exited'].includes(terminal.State.Status));
      this.run(['rm', owned.id]);
      assert.equal(
        this.run(['container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', 'id=' + owned.id]).trim(),
        ''
      );
    }
    this.save('cleanup-complete', { removed: this.owned.map((v) => v.id), onlyOwnedExactCids: true });
  }
}
export async function runOriginalWriterNative(baseline: string, writer: string, output: string) {
  const fixture = new NativeReaderFixture(output, baseline, writer),
    errors: unknown[] = [];
  try {
    await fixture.accept();
  } catch (error) {
    errors.push(error);
  }
  try {
    fixture.cleanup();
  } catch (error) {
    errors.push(error);
  }
  try {
    fs.closeSync(fixture.directory);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, 'Original writer acceptance/cleanup failed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 5) throw Error('Expected actual baseline image, writer image, new evidence directory');
  await runOriginalWriterNative(process.argv[2]!, process.argv[3]!, process.argv[4]!);
  process.stdout.write('Original helper metadata closure accepted; no current-policy claim.\n');
}
