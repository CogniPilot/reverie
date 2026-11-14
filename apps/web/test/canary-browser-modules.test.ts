/** Actual public code-file hashes + synthetic mount DATA, no Engine/native grant. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyCanaryModuleMounts } from './fixtures/boxed-canary-browser-proof.mjs';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(count = 3) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'canary-modules-'));
  roots.push(root);
  const names = ['engine-data.js', 'runtime.js', 'web/server.js'];
  const modules = Array.from({ length: count }, (_, index) => {
    const name = names[index] ?? 'module-' + index + '.js';
    const file = path.join(root, index + '.js'),
      bytes = Buffer.from('controlled public module ' + index);
    fs.writeFileSync(file, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      source: name,
      generatedFile: file,
      target: '/nix/store/controlled-console/lib/reverie/dist/' + name,
      sha256,
      inContainerSha: sha256,
      readOnly: true,
    };
  });
  return {
    modules,
    control: { Mounts: modules.map((m) => ({ Source: m.generatedFile, Destination: m.target, RW: false })) },
  };
}
describe('bounded real-browser development module verifier', () => {
  it('accepts sixteen exact read-only modules and checks the final module too', () => {
    const f = fixture(16);
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).not.toThrow();
    const last = f.modules.at(-1)!;
    last.inContainerSha = '0'.repeat(64);
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).toThrow();
    last.inContainerSha = last.sha256;
    f.control.Mounts.at(-1)!.RW = true;
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).toThrow();
    f.control.Mounts.at(-1)!.RW = false;
    fs.writeFileSync(last.generatedFile, 'changed last actual module');
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).toThrow();
  });
  it('refuses seventeen otherwise exact read-only modules', () => {
    const f = fixture(17);
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).toThrow();
  });
  it('checks all three actual file hashes and exact readonly mappings', () => {
    const f = fixture();
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).not.toThrow();
    fs.writeFileSync(f.modules[2].generatedFile, 'changed public module');
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).toThrow();
  });
  it('refuses writable, substituted, missing, duplicate or unrecorded mappings', () => {
    const f = fixture();
    for (const mutate of [
      (x: typeof f) => {
        x.control.Mounts[1].RW = true;
      },
      (x: typeof f) => {
        x.control.Mounts[1].Source = x.modules[0].generatedFile;
      },
      (x: typeof f) => {
        x.modules[1].inContainerSha = '0'.repeat(64);
      },
      (x: typeof f) => {
        x.control.Mounts.pop();
      },
      (x: typeof f) => {
        x.modules[1].target = x.modules[0].target;
      },
      (x: typeof f) => {
        x.control.Mounts.push({ ...x.control.Mounts[0], Destination: x.control.Mounts[0].Destination + '-extra' });
      },
    ]) {
      const copy = structuredClone(f);
      mutate(copy);
      expect(() => verifyCanaryModuleMounts(copy.control, { modules: copy.modules })).toThrow();
    }
  });
  it('preserves one-overlay and final baked no-overlay cases without dropped mounts', () => {
    const f = fixture(),
      m = f.modules[0];
    expect(() =>
      verifyCanaryModuleMounts(
        { Mounts: [f.control.Mounts[0]] },
        { overlay: { source: m.generatedFile, target: m.target, sha256: m.sha256, readOnly: true } }
      )
    ).not.toThrow();
    expect(() => verifyCanaryModuleMounts({ Mounts: [] }, {})).not.toThrow();
    expect(() => verifyCanaryModuleMounts(f.control, {})).toThrow();
  });
});
