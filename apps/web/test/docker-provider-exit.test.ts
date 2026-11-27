import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  DOCKER_PROVIDER_VIEW_PROGRAM,
  dockerProviderSocketLabel,
} from '../src/docker-employee-provider-view-native.js';
import {
  PROVIDER_EXIT_MAX_LINES,
  PROVIDER_EXIT_MAX_LINE_CHARS,
  describeDockerProviderExit,
  parseDockerProviderExit,
  providerExitLines,
  redactProviderOutput,
} from '../src/docker-provider-exit.js';

const sid = '20000000-0000-4000-8000-000000000002',
  oid = '30000000-0000-4000-8000-000000000003';
const report = (value: unknown) => 'EXITED ' + JSON.stringify(value) + '\n';

describe('what an exited boxed provider left behind', () => {
  it('reads a bounded report and leaves anything else to the ordinary reader', () => {
    expect(parseDockerProviderExit('ABSENT\n')).toBeUndefined();
    expect(parseDockerProviderExit('{"paneId":"%1"}\n')).toBeUndefined();
    const exit = parseDockerProviderExit(
      report({
        status: 1,
        signal: null,
        lines: [
          'Reverie Admin Harness could not start: Reverie API rejected the session lookup',
          'Pane is dead (status 1)',
        ],
      })
    );
    expect(exit).toEqual({
      status: 1,
      signal: null,
      lines: [
        'Reverie Admin Harness could not start: Reverie API rejected the session lookup',
        'Pane is dead (status 1)',
      ],
    });
    expect(Object.isFrozen(exit)).toBe(true);
    expect(parseDockerProviderExit(report({ status: null, signal: 9, lines: [] }))).toEqual({
      status: null,
      signal: 9,
      lines: [],
    });
  });
  it('refuses a malformed, oversized or unexplained report instead of guessing', () => {
    for (const bad of [
      'EXITED not json\n',
      report({ status: 1, signal: null, lines: [], extra: true }),
      report({ status: 256, signal: null, lines: [] }),
      report({ status: null, signal: null, lines: [] }),
      report({ status: 1, signal: null, lines: [7] }),
      report({ status: 1, signal: null, lines: Array(65).fill('x') }),
      'EXITED ' + JSON.stringify({ status: 1, signal: null, lines: [] }),
      report({ status: 1, signal: null, lines: Array(8).fill('y'.repeat(4000)) }),
    ])
      expect(() => parseDockerProviderExit(bad), bad.slice(0, 60)).toThrow();
  });
  it('keeps only the last lines, bounded, without terminal control sequences', () => {
    const lines = providerExitLines([
      ...Array.from({ length: 30 }, (_, index) => 'line ' + index),
      '',
      '   ',
      '\u001b[31mred\u001b[0m and \u001b]0;title\u0007plain\ttab\u0000nul',
      'w'.repeat(900),
    ]);
    expect(lines).toHaveLength(PROVIDER_EXIT_MAX_LINES);
    expect(lines[0]).toBe('line 20');
    expect(lines.at(-2)).toBe('red and plain tab nul');
    expect(lines.at(-1)).toHaveLength(PROVIDER_EXIT_MAX_LINE_CHARS);
    expect(lines.at(-1)?.endsWith('…')).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(lines.join('\n')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
  });
  it('removes what is obviously a credential and keeps the words around it', () => {
    const secret = 'synthetic' + 'A1b2C3d4'.repeat(6);
    const cases: Array<[string, string]> = [
      ['REVERIE_HANDS_API_KEY=' + secret + ' was refused', 'REVERIE_HANDS_API_KEY=[redacted] was refused'],
      ['Authorization: Bearer ' + secret, 'Authorization: [redacted]'],
      ['sent Bearer ' + secret + ' to the model', 'sent Bearer [redacted] to the model'],
      ['password: "two words" then', 'password: [redacted] then'],
      ['fetch http://owner:' + secret + '@model.test/v1 failed', 'fetch http://[redacted]@model.test/v1 failed'],
      ['key sk-' + 'abcDEF123456789012', 'key [redacted]'],
      ['digest ' + secret + ' rejected', 'digest [redacted] rejected'],
    ];
    for (const [line, expected] of cases) {
      const clean = redactProviderOutput(line);
      expect(clean, line).toBe(expected);
      expect(clean).not.toContain(secret);
    }
    const plain = 'Reverie Admin Harness could not start: Choose a local model endpoint for this Hands session';
    expect(redactProviderOutput(plain)).toBe(plain);
    expect(parseDockerProviderExit(report({ status: 1, signal: null, lines: ['api_key=' + secret] }))?.lines).toEqual([
      'api_key=[redacted]',
    ]);
  });
  it('says in one sentence how the agent ended, quoting its own last line', () => {
    expect(
      describeDockerProviderExit({
        status: 1,
        signal: null,
        lines: ['Reverie Admin Harness could not start: reason', 'Pane is dead (status 1, Mon Nov 23 2026)'],
      })
    ).toBe(
      'The agent exited with status 1 right after it started. Its last line was: Reverie Admin Harness could not start: reason'
    );
    expect(describeDockerProviderExit({ status: null, signal: 9, lines: [] })).toBe(
      'The agent was ended by signal 9 right after it started.'
    );
  });
});

/** Execute the actual fixed in-laptop program over controlled read-only ports. */
function presence(pane: { dead: string; screen?: string; operation?: string }) {
  const label = dockerProviderSocketLabel(sid, 'session-v1'),
    calls: string[][] = [];
  let stdout = '',
    exit: number | undefined;
  const stopped = new Error('bounded native exit');
  const directory = (uid: number) => ({ uid, mode: 0o40700, isDirectory: () => true, isFile: () => false });
  const fsPort = {
    lstatSync(path: string) {
      if (path === '/opt/reverie-worker-tools/bin/tmux') return { uid: 0, mode: 0o100555, isFile: () => true };
      if (path === '/tmp/tmux-1000') return directory(1000);
      if (path === '/tmp/tmux-1000/' + label) return { uid: 1000, isSocket: () => true };
      return directory(0);
    },
    statfsSync: () => ({ type: 0x9fa0 }),
    statSync: () => ({ uid: 1000 }),
    readFileSync: (path: string) =>
      path === '/proc/self/status'
        ? 'NoNewPrivs: 1\nCapInh: 0\nCapPrm: 0\nCapEff: 0\nCapAmb: 0\n'
        : '42 (fixed) S ' + Array(18).fill('0').join(' ') + ' 123',
  };
  const child = {
    spawnSync(_program: string, argv: string[], options: { maxBuffer: number }) {
      calls.push(argv);
      if (argv.includes('list-sessions')) return { status: 0, stdout: 'reverie-dkr-' + sid + '\n', stderr: '' };
      if (argv.includes('capture-pane')) {
        expect(options.maxBuffer).toBeGreaterThan(4096);
        return { status: 0, stdout: pane.screen ?? '' };
      }
      if (argv.includes('display-message'))
        return { status: 0, stdout: argv.at(-1)!.includes('pane_dead_status') ? pane.dead : '%1 0 42\n' };
      if (argv.includes('show-environment'))
        return {
          status: 0,
          stdout:
            argv.at(-1) === 'REVERIE_SESSION_ID'
              ? 'REVERIE_SESSION_ID=' + sid + '\n'
              : 'REVERIE_DOCKER_OPERATION_ID=' + (pane.operation ?? oid) + '\n',
        };
      return { status: 0, stdout: '' };
    },
  };
  const processPort = {
    argv: ['node', '--runtime-namespace=session-v1', 'presence', sid, oid, 'none'],
    getuid: () => 1000,
    env: {},
    stdout: { write: (text: string) => void (stdout += text) },
    exit: (code: number) => {
      exit = code;
      throw stopped;
    },
  };
  try {
    runInNewContext(
      DOCKER_PROVIDER_VIEW_PROGRAM,
      { require: (name: string) => (name === 'node:fs' ? fsPort : child), process: processPort },
      { timeout: 1000 }
    );
  } catch (error) {
    if (error !== stopped) throw error;
  }
  return { stdout, exit, calls };
}

describe('the in-laptop presence read of a retained dead pane', () => {
  it('reports the exit status and the last screen instead of refusing or calling it running', () => {
    const screen =
      ['first', '', 'Reverie Admin Harness could not start: Reverie API rejected the session lookup', ''].join('\n') +
      '\n'.repeat(18) +
      'Pane is dead (status 1, Mon Nov 23 22:10:00 2026)\n';
    const result = presence({ dead: '1|1|\n', screen });
    expect(result.exit).toBe(0);
    expect(parseDockerProviderExit(result.stdout)).toEqual({
      status: 1,
      signal: null,
      lines: [
        'first',
        'Reverie Admin Harness could not start: Reverie API rejected the session lookup',
        'Pane is dead (status 1, Mon Nov 23 22:10:00 2026)',
      ],
    });
    expect(
      result.calls.every((argv) => argv[argv.indexOf('-L') + 1] === dockerProviderSocketLabel(sid, 'session-v1'))
    ).toBe(true);
    expect(result.calls.some((argv) => argv.includes('kill-session') || argv.includes('respawn-pane'))).toBe(false);
  });
  it('reports a signal death and bounds a long screen inside the laptop', () => {
    const result = presence({
      dead: '1||9\n',
      screen: Array.from({ length: 80 }, (_, index) => 'row ' + index + ' ' + 'z'.repeat(2000)).join('\n') + '\n',
    });
    const exit = parseDockerProviderExit(result.stdout)!;
    expect(exit.status).toBeNull();
    expect(exit.signal).toBe(9);
    expect(exit.lines).toHaveLength(PROVIDER_EXIT_MAX_LINES);
    expect(exit.lines[0]?.startsWith('row 68 ')).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(16 * 1024);
  });
  it('still reports a live pane as the running provider', () => {
    const result = presence({ dead: '0||\n' });
    expect(JSON.parse(result.stdout)).toMatchObject({ paneId: '%1', panePid: 42, paneStartTicks: '123' });
    expect(result.calls.some((argv) => argv.includes('capture-pane'))).toBe(false);
  });
  it('refuses a dead pane that belongs to another operation', () => {
    expect(() => presence({ dead: '1|1|\n', operation: '99999999-0000-4000-8000-000000000009' })).toThrow(
      'Existing Docker provider view unavailable'
    );
  });
});
