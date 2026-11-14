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
  function publicAppFixture() {
    const f = fixture(14);
    const target = '/nix/store/controlled-console/lib/reverie/src/web/public/app.js';
    f.modules[13].source = 'src/web/public/app.js';
    f.modules[13].target = target;
    f.control.Mounts[13].Destination = target;
    return f;
  }
  it('accepts the exact fourteen-module census including thirteen dist files and shipped public app', () => {
    const f = publicAppFixture();
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).not.toThrow();
  });
  it('refuses an unlisted or duplicate actual public app mount', () => {
    const f = publicAppFixture();
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules.slice(0, 13) })).toThrow();
    f.control.Mounts.push({ ...f.control.Mounts[13] });
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).toThrow();
  });
  it('checks the public app readonly mapping and both recorded and actual file hashes', () => {
    const f = publicAppFixture();
    const app = f.modules[13];
    for (const mutate of [
      (value: typeof f) => {
        value.control.Mounts[13].RW = true;
      },
      (value: typeof f) => {
        value.control.Mounts[13].Source = value.modules[0].generatedFile;
      },
      (value: typeof f) => {
        value.modules[13].inContainerSha = '0'.repeat(64);
      },
      (value: typeof f) => {
        value.modules[13].sha256 = '0'.repeat(64);
      },
      (value: typeof f) => {
        value.control.Mounts.pop();
      },
      (value: typeof f) => {
        value.modules[13].target = value.modules[0].target;
      },
    ]) {
      const copy = structuredClone(f);
      mutate(copy);
      expect(() => verifyCanaryModuleMounts(copy.control, { modules: copy.modules })).toThrow();
    }
    fs.writeFileSync(app.generatedFile, 'changed shipped public app');
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).toThrow();
  });
  it('does not admit arbitrary public code as the reviewed app target', () => {
    const f = publicAppFixture();
    f.modules[13].target = f.control.Mounts[13].Destination =
      '/nix/store/controlled-console/lib/reverie/src/web/public/other.js';
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).toThrow();
  });
  it('accepts the seventeen-module runtime and asset census without skipping the added route', () => {
    const f = fixture(17);
    const last = f.modules[16];
    last.source = 'apps/web/src/web/routes/company-routes.ts';
    last.target = '/nix/store/controlled-console/lib/reverie/dist/web/routes/company-routes.js';
    f.control.Mounts[16].Destination = last.target;
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).not.toThrow();
    f.control.Mounts[16].RW = true;
    expect(() => verifyCanaryModuleMounts(f.control, { modules: f.modules })).toThrow();
  });
  it('accepts twenty exact read-only modules and checks the final module too', () => {
    const f = fixture(20);
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
  it('refuses twenty-one otherwise exact read-only modules', () => {
    const f = fixture(21);
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
