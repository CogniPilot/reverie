/** Read-only native source admission, independent of the disposable viewer.
 * A private source observation never grants STOP, CREATE or paid dispatch. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DockerEmployeeBinding, DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { DockerEmployeeInspect, boxedOriginal } from './docker-employee-engine-data.js';
import { DockerEmployeeContinuationError, dockerContinuationDigest } from './docker-employee-continuation.js';
import { parseWorkerClientReadback } from './worker-client-manifest.js';
import { DOCKER_PROVIDER_VIEW_ENV, dockerPlanProviderSelection } from './docker-employee-provider-view-native.js';
import { requireDockerEmployeeProviderView, type DockerEmployeeProviderView } from './docker-employee-engine.js';
import type { SessionDocker } from './types/session.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import type { DockerPlanMoveSeed } from './docker-plan-move-data.js';

/** Fixed bootstrap clears supplement the existing view protocol. A bare Docker
 * environment key removes it: an empty LD_SHOW_AUXV still enables loader output.
 * PackagedDockerEngineCommand passes only PATH/HOME, so the CLI cannot inherit
 * these keys from its own environment. No provider, write or signal is issued. */
const DOCKER_PLAN_SOURCE_ENV = Object.freeze([
  ...DOCKER_PROVIDER_VIEW_ENV,
  ...[
    'NODE_V8_COVERAGE',
    'NODE_COMPILE_CACHE',
    'NODE_REPL_EXTERNAL_MODULE',
    'NODE_EXTRA_CA_CERTS',
    'LD_DEBUG',
    'LD_DEBUG_OUTPUT',
    'LD_PROFILE',
    'LD_TRACE_LOADED_OBJECTS',
    'LD_SHOW_AUXV',
    'LD_WARN',
    'LD_VERBOSE',
    'MALLOC_TRACE',
  ].flatMap((key) => ['--env', key]),
]);
export const DOCKER_PLAN_INIT_PROGRAM = String.raw`const fs=require('node:fs');
function refuse(){throw Error('Docker init identity unconfirmed');}
if(fs.statfsSync('/proc').type!==0x9fa0)refuse();
const status=fs.readFileSync('/proc/self/status','utf8');
if(!/^NoNewPrivs:\s+1$/m.test(status)||!['CapInh','CapPrm','CapEff','CapAmb'].every(k=>new RegExp('^'+k+':\\s+0+$','m').test(status)))refuse();
for(const path of ['/','/opt','/opt/reverie-worker-client','/opt/reverie-worker-client/bin']){const s=fs.lstatSync(path);if(!s.isDirectory()||s.uid!==0||(s.mode&0o022)!==0)refuse();}
const file=fs.lstatSync('/opt/reverie-worker-client/bin/node');if(!file.isFile()||file.uid!==0||(file.mode&0o222)!==0||(file.mode&0o111)===0)refuse();
function read(){const text=fs.readFileSync('/proc/1/stat','utf8'),end=text.lastIndexOf(') ');if(!text.startsWith('1 (')||end<0)refuse();const fields=text.slice(end+2).trim().split(/\s+/),ticks=fields[19];if(!/^[1-9][0-9]{0,19}$/.test(ticks||''))refuse();return ticks;}
const a=read(),b=read();if(a!==b)refuse();process.stdout.write(JSON.stringify({startTicks:b})+'\n');`;

const origin = Symbol('actual Docker plan source observation');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceInspect = DockerEmployeeInspect.extend({
  State: DockerEmployeeInspect.shape.State.extend({
    Pid: z.number().int().nonnegative().max(2147483647),
    Status: z.string().min(1).max(40),
  }),
});
const nativeInit = z.object({ startTicks: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict();
function refuse(): never {
  throw new DockerEmployeeContinuationError('DOCKER_PLAN_SOURCE_UNCONFIRMED');
}
function subject(row: DockerEmployeeContinuationRecord) {
  return {
    employeeId: row.employeeId,
    sessionId: row.request.sessionId,
    sessionGeneration: row.request.sessionGeneration,
    owner: row.owner,
    sourceDigest: row.sourceDigest,
    providerSourceDigest: row.version === 1 ? row.sourceDigest : row.providerSourceDigest,
    onVacation: false,
    desiredRunning: true,
  };
}
export class DockerPlanSourceProof {
  readonly #rowDigest: string;
  readonly #binding: DockerEmployeeBinding;
  readonly #seen: DockerPlanMoveSeed['source']['observation'];
  readonly #current: () => void;
  readonly #at: number;
  #revoked = false;
  constructor(
    token: symbol,
    row: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding,
    seen: DockerPlanMoveSeed['source']['observation'],
    current: () => void,
    at: number
  ) {
    if (token !== origin) refuse();
    this.#rowDigest = dockerContinuationDigest(row);
    this.#binding = Object.freeze(structuredClone(binding));
    this.#seen = Object.freeze(structuredClone(seen));
    this.#current = current;
    this.#at = at;
    Object.freeze(this);
  }
  require(row: DockerEmployeeContinuationRecord, binding: DockerEmployeeBinding): void {
    if (this.#revoked) refuse();
    try {
      this.#current();
      const age = performance.now() - this.#at;
      if (
        age < 0 ||
        age > 5000 ||
        this.#rowDigest !== dockerContinuationDigest(row) ||
        !isDeepStrictEqual(binding, this.#binding)
      )
        refuse();
      this.#current();
    } catch (error) {
      this.#revoked = true;
      throw error;
    }
  }
  observation(
    row: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding
  ): DockerPlanMoveSeed['source']['observation'] {
    this.require(row, binding);
    return structuredClone(this.#seen);
  }
}
Object.freeze(DockerPlanSourceProof.prototype);
export class DockerPlanSourceReader {
  readonly #run: DockerEngineCommand['run'];
  readonly #deployment: string;
  readonly #box: string;
  readonly #apiUrl: string;
  readonly #view: (row: DockerEmployeeContinuationRecord, current: () => void) => Promise<DockerEmployeeProviderView>;
  readonly #image: (row: DockerEmployeeContinuationRecord, current: () => void) => Promise<void>;
  constructor(
    command: DockerEngineCommand,
    deployment: string,
    box: string,
    apiUrl: string,
    view: (row: DockerEmployeeContinuationRecord, current: () => void) => Promise<DockerEmployeeProviderView>,
    image: (row: DockerEmployeeContinuationRecord, current: () => void) => Promise<void>
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(deployment) || !digest.safeParse(box).success) refuse();
    this.#run = command.run.bind(command);
    this.#deployment = deployment;
    this.#box = box;
    this.#apiUrl = z.string().url().max(2048).parse(apiUrl);
    this.#view = view;
    this.#image = image;
    Object.freeze(this);
  }
  async #native(args: readonly string[]): Promise<string> {
    try {
      return await this.#run(args);
    } catch {
      refuse();
    }
  }
  async #inspect(
    row: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding,
    current: () => void
  ): Promise<z.infer<typeof sourceInspect>> {
    current();
    const text = await this.#native(['container', 'inspect', binding.containerId]);
    current();
    let raw: z.infer<typeof sourceInspect>;
    try {
      raw = z.array(sourceInspect).length(1).parse(JSON.parse(text))[0]!;
    } catch {
      refuse();
    }
    const labels = raw.Config.Labels,
      host = raw.HostConfig,
      actual = boxedOriginal(raw, subject(row), this.#deployment, true);
    if (
      raw.Id !== binding.containerId ||
      raw.Image !== binding.imageId ||
      !isDeepStrictEqual(actual, row.destination) ||
      labels?.['reverie.boxed.box'] !== this.#box ||
      labels['reverie.boxed.operation'] !== binding.operationId ||
      labels['reverie.boxed.generation'] !== String(binding.sessionGeneration) ||
      labels['org.reverie.worker-client.manifest'] !== row.workerImage.clientManifestDigest ||
      raw.State.Paused ||
      raw.State.Restarting ||
      raw.State.Dead ||
      host.AutoRemove !== false ||
      !isDeepStrictEqual(host.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 }) ||
      Number(raw.Config.User.split(':')[0]) === 0
    )
      refuse();
    if (
      raw.Mounts.some((m) =>
        ['/opt/reverie-worker-client', '/opt/reverie-worker-tools', '/proc'].some(
          (prefix) =>
            m.Destination === '/' ||
            m.Destination === prefix ||
            prefix.startsWith(m.Destination + '/') ||
            m.Destination.startsWith(prefix + '/')
        )
      )
    )
      refuse();
    if (
      raw.State.Running
        ? raw.State.Pid <= 0
        : raw.State.Pid !== 0 || !['created', 'exited'].includes(raw.State.Status ?? '')
    )
      refuse();
    current();
    return raw;
  }
  #checked(row: DockerEmployeeContinuationRecord, binding: DockerEmployeeBinding): void {
    try {
      DockerEmployeeContinuationRecord.parse(row);
      DockerEmployeeBinding.parse(binding);
    } catch {
      refuse();
    }
    if (
      !row.destination ||
      !['provider-issued', 'ready'].includes(row.phase) ||
      binding.sessionId !== row.request.sessionId ||
      binding.sessionGeneration !== row.request.sessionGeneration ||
      binding.operationId !== row.request.operationId ||
      binding.containerId !== row.destination.containerId ||
      binding.imageId !== row.destination.imageId ||
      binding.credentialId !== row.credentialId ||
      binding.originalDigest !== dockerContinuationDigest(row.destination) ||
      binding.policyDigest !== dockerContinuationDigest(row.policy)
    )
      refuse();
  }
  async #init(row: DockerEmployeeContinuationRecord, current: () => void): Promise<z.infer<typeof nativeInit>> {
    current();
    const text = await this.#native([
      'exec',
      ...DOCKER_PLAN_SOURCE_ENV,
      row.destination!.containerId,
      '/opt/reverie-worker-client/bin/node',
      '--no-global-search-paths',
      '--no-addons',
      '--input-type=commonjs',
      '-e',
      DOCKER_PLAN_INIT_PROGRAM,
    ]);
    current();
    if (Buffer.byteLength(text) > 4096) refuse();
    try {
      return nativeInit.parse(JSON.parse(text));
    } catch {
      refuse();
    }
  }
  async capture(
    row: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding,
    current: () => void,
    force: boolean
  ): Promise<DockerPlanSourceProof> {
    current();
    this.#checked(row, binding);
    const rowDigest = dockerContinuationDigest(row);
    const check = () => {
      current();
      if (dockerContinuationDigest(row) !== rowDigest) refuse();
    };
    await this.#image(row, check);
    check();
    // Qualification may include preliminary native checks. All returned source
    // facts are freshly sampled below, with the existing first/last bookends;
    // their five-second lifetime begins before that first dynamic sample.
    const at = performance.now();
    const first = await this.#inspect(row, binding, check);
    if (!first.State.Running) {
      const after = await this.#inspect(row, binding, check);
      if (
        after.State.Running ||
        after.State.Pid !== 0 ||
        first.State.Pid !== 0 ||
        !isDeepStrictEqual(first.State, after.State)
      )
        refuse();
      if (!force) refuse();
      const proof = new DockerPlanSourceProof(
        origin,
        row,
        binding,
        { kind: 'stopped', terminalStateDigest: dockerContinuationDigest(after.State) },
        check,
        at
      );
      proof.require(row, binding);
      return proof;
    }
    parseWorkerClientReadback(
      await this.#native([
        'exec',
        binding.containerId,
        '/opt/reverie-worker-client/bin/reverie',
        'worker-client',
        'status',
        '--expected-digest',
        row.workerImage.clientManifestDigest,
      ]),
      row.workerImage.clientManifestDigest
    );
    check();
    const before = await this.#init(row, check);
    let provider: { kind: 'observed'; viewDigest: string } | { kind: 'unobserved' } = { kind: 'unobserved' };
    try {
      const view = await this.#view(row, check);
      check();
      const d = view.descriptor;
      requireDockerEmployeeProviderView(view, binding.sessionId, {
        engine: 'docker',
        containerName: binding.containerId,
        image: binding.imageId,
        owned: false,
        daemonHost: 'unix:///run/reverie-engine/docker.sock',
        continuation: {
          apiUrl: this.#apiUrl,
          operationId: binding.operationId,
          employeeId: row.employeeId,
          sessionGeneration: binding.sessionGeneration,
          clientManifestDigest: row.workerImage.clientManifestDigest,
          ...(row.version === 3
            ? {
                planReplacement: dockerPlanProviderSelection(row.planReplacement),
              }
            : {}),
        },
      } as SessionDocker);
      check();
      provider = { kind: 'observed', viewDigest: dockerContinuationDigest(d) };
    } catch (error) {
      check();
      if (!force) throw error;
    }
    const after = await this.#inspect(row, binding, check),
      last = await this.#init(row, check);
    if (!after.State.Running || after.State.Pid !== first.State.Pid || !isDeepStrictEqual(before, last)) refuse();
    const proof = new DockerPlanSourceProof(
      origin,
      row,
      binding,
      { kind: 'running', init: { pid: after.State.Pid, startTicks: last.startTicks }, provider },
      check,
      at
    );
    proof.require(row, binding);
    return proof;
  }
}
Object.freeze(DockerPlanSourceReader.prototype);
