/** Private filesystem for the CI-only SDK fake. No production import or arbitrary host repair. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlanRequestId } from '../../src/plan-request-capability.js';
import { PlanProviderFixtureContract, type PlanProviderFixtureReport } from './boxed-plan-provider.js';
const C = fs.constants,
  mode = (stat: fs.Stats) => stat.mode & 0o7777;
const identity = (s: fs.Stats) => [s.dev, s.ino, s.uid, s.gid, mode(s)].join(':');
const stamp = (s: fs.Stats) => [identity(s), s.size, s.mtimeMs, s.ctimeMs, s.nlink].join(':');
const digest = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const at = (fd: number, leaf: string) => `/proc/self/fd/${fd}/${leaf}`;
function directory(file: string): number {
  const fd = fs.openSync(file, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (
      !st.isDirectory() ||
      st.uid !== process.getuid?.() ||
      st.gid !== process.getgid?.() ||
      mode(st) !== 0o700 ||
      identity(st) !== identity(fs.lstatSync(file))
    )
      throw Error('Private fixture directory refused');
    return fd;
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch (close) {
      throw new AggregateError([error, close], 'Fixture open and close failed');
    }
    throw error;
  }
}
function owned<T>(fd: number, operation: (fd: number) => T): T {
  let value: T | undefined,
    cause: unknown,
    failed = false;
  try {
    value = operation(fd);
  } catch (error) {
    cause = error;
    failed = true;
  }
  // Exactly one consuming close. Never retry its descriptor number after an unknown result.
  try {
    fs.closeSync(fd);
  } catch (error) {
    if (failed) throw new AggregateError([cause, error], 'Fixture operation and close failed');
    throw error;
  }
  if (failed) throw cause;
  return value as T;
}
function read(fd: number, leaf: string): Buffer {
  const file = at(fd, leaf),
    child = fs.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  return owned(child, () => {
    const before = fs.fstatSync(child);
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.gid !== process.getgid?.() ||
      mode(before) !== 0o600 ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 65536 ||
      stamp(before) !== stamp(fs.lstatSync(file))
    )
      throw Error('Private fixture file refused');
    const buffer = Buffer.alloc(65537);
    let count = 0;
    while (count < buffer.length) {
      const n = fs.readSync(child, buffer, count, buffer.length - count, null);
      if (!n) break;
      count += n;
    }
    if (
      count !== before.size ||
      count > 65536 ||
      stamp(fs.fstatSync(child)) !== stamp(before) ||
      stamp(fs.lstatSync(file)) !== stamp(before)
    )
      throw Error('Private fixture file changed');
    return buffer.subarray(0, count);
  });
}
function json(bytes: Buffer): unknown {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw Error('Fixture UTF8 refused');
  return JSON.parse(text);
}
function write(fd: number, leaf: string, bytes: Buffer): void {
  const file = at(fd, leaf),
    child = fs.openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  owned(child, () => {
    fs.writeFileSync(child, bytes);
    fs.fsyncSync(child);
    const st = fs.fstatSync(child);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      mode(st) !== 0o600 ||
      st.uid !== process.getuid?.() ||
      st.gid !== process.getgid?.() ||
      st.size !== bytes.length ||
      stamp(st) !== stamp(fs.lstatSync(file))
    )
      throw Error('Fixture publication refused');
  });
  fs.fsyncSync(fd);
}
export class PlanProviderFixtureFiles {
  #serial = 0;
  /** home is a test-owned mapping in unit cases; the image entry always supplies literal /home/agent. */
  constructor(
    readonly home: string,
    readonly claudeConfigDir: string | undefined
  ) {
    if (
      process.getuid?.() === undefined ||
      process.getuid?.() === 0 ||
      !path.isAbsolute(home) ||
      path.resolve(home) !== home
    )
      throw Error('Positive owned fixture UID/HOME required');
  }
  #scope<T>(operation: (home: number, fixture: number) => T): T {
    const root = directory(this.home);
    return owned(root, () => {
      const rootStamp = identity(fs.fstatSync(root)),
        file = at(root, '.fixture'),
        fixture = directory(file);
      return owned(fixture, () => {
        const childStamp = identity(fs.fstatSync(fixture)),
          result = operation(root, fixture);
        if (
          identity(fs.fstatSync(root)) !== rootStamp ||
          identity(fs.lstatSync(this.home)) !== rootStamp ||
          identity(fs.fstatSync(fixture)) !== childStamp ||
          identity(fs.lstatSync(file)) !== childStamp
        )
          throw Error('Fixture directory changed');
        return result;
      });
    });
  }
  contract() {
    return this.#scope((_home, fixture) =>
      PlanProviderFixtureContract.parse(json(read(fixture, 'plan-provider.json')))
    );
  }
  prepareApproval(id: string, handoff: string): 'prepared' | 'existing' {
    PlanRequestId.parse(id);
    return this.#scope((_home, fixture) => {
      const intent = `plan-intent-${id}.json`;
      try {
        fs.lstatSync(at(fixture, intent));
        return 'existing';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      write(
        fixture,
        intent,
        Buffer.from(JSON.stringify({ version: 1, purpose: 'synthetic-plan-approval-intent-v1', requestId: id }) + '\n')
      );
      write(fixture, `plan-handoff-${id}.txt`, Buffer.from(handoff));
      return 'prepared';
    });
  }
  record(report: Readonly<PlanProviderFixtureReport>) {
    z.string().uuid().parse(report.sessionId);
    if (!Number.isSafeInteger(report.namespacePid) || report.namespacePid <= 1)
      throw Error('Fixture receipt identity refused');
    return this.#scope((_home, fixture) =>
      write(
        fixture,
        `plan-turn-${report.sessionId}-${report.namespacePid}-${this.#serial++}.json`,
        Buffer.from(JSON.stringify(report) + '\n')
      )
    );
  }
  authStatus() {
    const selected = this.claudeConfigDir ?? this.home + '/.claude';
    const relative = selected.slice(this.home.length + 1);
    if (
      selected !== this.home + '/.claude' &&
      (!selected.startsWith(this.home + '/') ||
        !/^\.reverie\/plan-moves\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/generation-[a-f0-9]{64}\/claude$/.test(
          relative
        ))
    )
      throw Error('Synthetic auth selection refused');
    return this.#scope((home) => {
      const walk = (
        parent: number,
        parts: string[]
      ): { loggedIn: true; authMethod: string; apiProvider: string; email: string } => {
        if (parts.length) return owned(directory(at(parent, parts[0]!)), (fd) => walk(fd, parts.slice(1)));
        const value = json(read(parent, '.credentials.json')) as { claudeAiOauth?: { accessToken?: unknown } };
        if (
          typeof value?.claudeAiOauth?.accessToken !== 'string' ||
          !value.claudeAiOauth.accessToken.startsWith('synthetic-')
        )
          throw Error('Synthetic account required');
        return {
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          email: 'ci-plan-fixture@example.invalid',
        };
      };
      return walk(home, relative.split('/'));
    });
  }
  refreshAuthOnce(accountId: string) {
    PlanRequestId.parse(accountId);
    return this.#scope((home, fixture) => {
      const contract = PlanProviderFixtureContract.parse(json(read(fixture, 'plan-provider.json')));
      if (contract.refreshAccountId !== accountId) throw Error('Fixture refresh account refused');
      const marker = `plan-refresh-${accountId}.json`;
      try {
        fs.lstatSync(at(fixture, marker));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const prefix = this.home + '/.reverie/plan-moves/';
      if (!this.claudeConfigDir?.startsWith(prefix)) throw Error('Fixture generation root refused');
      const relative = this.claudeConfigDir.slice(this.home.length + 1);
      if (
        !/^\.reverie\/plan-moves\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/generation-[a-f0-9]{64}\/claude$/.test(
          relative
        )
      )
        throw Error('Fixture generation path refused');
      const walk = (parent: number, parts: string[], operation: (leaf: number) => void): void => {
        if (!parts.length) {
          operation(parent);
          return;
        }
        const name = parts[0]!,
          fd = directory(at(parent, name));
        owned(fd, () => {
          walk(fd, parts.slice(1), operation);
          if (identity(fs.fstatSync(fd)) !== identity(fs.lstatSync(at(parent, name))))
            throw Error('Fixture generation changed');
        });
      };
      walk(home, relative.split('/'), (leaf) => {
        const before = read(leaf, '.credentials.json'),
          value = json(before) as { claudeAiOauth?: Record<string, unknown> };
        if (
          !value ||
          Array.isArray(value) ||
          typeof value.claudeAiOauth?.accessToken !== 'string' ||
          !value.claudeAiOauth.accessToken.startsWith('synthetic-')
        )
          throw Error('Only fake SDK credentials are accepted');
        value.claudeAiOauth.accessToken = 'synthetic-refreshed-' + accountId;
        const after = Buffer.from(JSON.stringify(value) + '\n'),
          stage = 'sdk-refresh-' + randomUUID() + '.json';
        write(leaf, stage, after);
        if (!read(leaf, stage).equals(after)) throw Error('Fixture refresh staging differs');
        fs.renameSync(at(leaf, stage), at(leaf, '.credentials.json'));
        fs.fsyncSync(leaf);
        if (!read(leaf, '.credentials.json').equals(after)) throw Error('Fixture refresh differs');
        write(
          fixture,
          marker,
          Buffer.from(
            JSON.stringify({
              version: 1,
              purpose: 'synthetic-sdk-refresh-v1',
              accountId,
              beforeDigest: digest(before),
              afterDigest: digest(after),
            }) + '\n'
          )
        );
      });
    });
  }
}

/** Control account probes read ONLY the two build-only fake accounts; no vendor network or token output. */
export function planFixtureAccountStatus(configDir: string | undefined) {
  if (configDir !== '/fixture/accounts/plan-a' && configDir !== '/fixture/accounts/plan-b')
    throw Error('Fixed synthetic control account required');
  return owned(directory('/fixture'), (root) =>
    owned(directory(at(root, 'accounts')), (accounts) =>
      owned(directory(at(accounts, configDir.endsWith('/plan-a') ? 'plan-a' : 'plan-b')), (account) => {
        const value = json(read(account, '.credentials.json')) as { claudeAiOauth?: { accessToken?: unknown } };
        if (
          typeof value?.claudeAiOauth?.accessToken !== 'string' ||
          !value.claudeAiOauth.accessToken.startsWith('synthetic-')
        )
          throw Error('Synthetic account required');
        return {
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          email: 'ci-plan-fixture@example.invalid',
        };
      })
    )
  );
}
