/** Actual fake-provider witness functions + private files. No provider, shell, HTTP or Engine. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import ts from 'typescript';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'provider-input-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const source = ts.createSourceFile(
    'fixture.cjs',
    fs.readFileSync(new URL('./fixtures/boxed-fake-provider.cjs', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const names = new Set(['inputWitness', 'listenForInputWitness']);
  const declarations = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)
  );
  expect(declarations).toHaveLength(2);
  const stdin = new PassThrough();
  let stdout = '',
    stderr = '';
  vm.runInNewContext(declarations.map((node) => node.getText(source)).join('\n') + '\nlistenForInputWitness();', {
    fs,
    path,
    sid: '22222222-2222-4222-8222-222222222222',
    thread: '44444444-4444-4444-8444-444444444444',
    process: {
      env: { HOME: root },
      pid: process.pid,
      stdin,
      stdout: {
        write: (text: string) => {
          stdout += text;
        },
      },
      stderr: {
        write: (text: string) => {
          stderr += text;
        },
      },
    },
  });
  return {
    root,
    stdin,
    file: path.join(root, 'boxed-canary-provider-input.json'),
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
const first = '11111111-1111-4111-8111-111111111111';
const second = '55555555-5555-4555-8555-555555555555';
const challenge = (uuid: string) => 'BOXED_CANARY_INPUT_' + uuid;
describe('maintained fake provider input witness', () => {
  it('writes a real exclusive private receipt and acknowledges exactly one split ASCII input', () => {
    const f = fixture();
    const user = path.join(f.root, 'memory.txt');
    fs.writeFileSync(user, 'retained user data');
    f.stdin.write('unrelated shell text\n' + 'x'.repeat(200) + '\n' + 'é\n');
    expect(fs.existsSync(f.file)).toBe(false);
    f.stdin.write(challenge(first).slice(0, 22));
    f.stdin.write(challenge(first).slice(22) + '\r');
    const before = fs.statSync(f.file);
    const receipt = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    expect(receipt).toMatchObject({
      purpose: 'synthetic-boxed-provider-input-v1',
      challenge: challenge(first),
      sessionId: '22222222-2222-4222-8222-222222222222',
      pid: process.pid,
    });
    expect(before.mode & 0o777).toBe(0o600);
    expect(before.nlink).toBe(1);
    expect(f.stdout()).toBe('BOXED_CANARY_ACK_' + first + '\n');
    f.stdin.write(challenge(second) + '\n');
    expect(fs.statSync(f.file).ino).toBe(before.ino);
    expect(f.stdout()).toBe('BOXED_CANARY_ACK_' + first + '\n');
    expect(f.stderr()).toBe('');
    expect(fs.readFileSync(user, 'utf8')).toBe('retained user data');
  });
  it('refuses a pre-existing receipt without overwrite, ACK or a second write attempt', () => {
    const f = fixture();
    fs.writeFileSync(f.file, 'existing private data', { mode: 0o600 });
    const before = fs.statSync(f.file);
    f.stdin.write(challenge(first) + '\n');
    f.stdin.write(challenge(second) + '\n');
    expect(fs.readFileSync(f.file, 'utf8')).toBe('existing private data');
    expect(fs.statSync(f.file).ino).toBe(before.ino);
    expect(f.stdout()).toBe('');
    expect(f.stderr()).toBe('Synthetic input witness unconfirmed; no retry.\n');
  });
});
