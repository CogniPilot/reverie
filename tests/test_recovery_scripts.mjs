// Run with node --test tests/test_recovery_scripts.mjs. Fake engine only: no podman, no host changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("REVERIE_")) delete process.env[key];
}
const scripts = resolve(import.meta.dirname, "..", "scripts");
const BASH = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
assert.ok(BASH.startsWith("/"), "The recovery fixtures require an available Bash interpreter");

function restoreTree() {
  const root = mkdtempSync(join(tmpdir(), "reverie-restore-"));
  const rescue = join(root, "rescue"), home = join(root, "home"), opt = join(root, "opt");
  const write = (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  write(join(rescue, "home-cto", "claude", "credentials.json"), "creds");
  write(join(rescue, "home-cto", "claude", "settings.json"), "settings");
  write(join(rescue, "home-cto", "claude", "someone-MEMORY.md"), "memory");
  write(join(rescue, "home-cto", "config", ".claude.json"), "cfg");
  write(join(rescue, "home-cto", "config", "opencode.jsonc"), "oc");
  write(join(rescue, "home-cto", "scratch", "console-backup", "company-ui.js"), "backup");
  for (const f of ["opencode.db", "opencode.db-wal", "opencode.db-shm", "opencode.log"]) write(join(rescue, "opencode", f), f);
  write(join(rescue, "opt-console", "src", "a.ts"), "live-a"); write(join(rescue, "opt-console", "dist", "x.js"), "dist");
  write(join(opt, "apps", "web", "src", "a.ts"), "image-a"); write(join(opt, "apps", "web", "dist", "x.js"), "other-dist");
  write(join(rescue, "opt-reverie-python", "site-packages", "cto", "runtime.py"), "rt");
  write(join(opt, "python", "lib", "python3.11", "site-packages", "reverie", "runtime.py"), "rt");
  write(join(home, ".claude", "settings.json"), "newer-settings");
  return { root, rescue, home, opt };
}

function restore(t, pgrep, ...args) {
  return spawnSync("bash", [join(scripts, "reverie-restore"), "--rescue", t.rescue, "--home", t.home, "--opt", t.opt, ...args],
    { env: { PATH: process.env.PATH, HOME: t.home, RESTORE_PGREP: pgrep }, encoding: "utf8" });
}

test("restore: dry run changes nothing; a real run restores with backups and private modes", () => {
  const t = restoreTree();
  const dry = restore(t, "false", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(existsSync(join(t.home, ".claude", ".credentials.json")), false);
  const r = restore(t, "false");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(t.home, ".claude", ".credentials.json"), "utf8"), "creds");
  assert.equal(statSync(join(t.home, ".claude", ".credentials.json")).mode & 0o777, 0o600);
  const backups = readdirSync(join(t.home, ".claude")).filter((n) => n.startsWith("settings.json.pre-restore-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(t.home, ".claude", backups[0]), "utf8"), "newer-settings");
  assert.equal(readFileSync(join(t.home, ".local", "share", "opencode", "opencode.db"), "utf8"), "opencode.db");
  assert.equal(existsSync(join(t.home, ".claude", "someone-MEMORY.md")), false);
  assert.match(r.stdout, /left for its owner/);
  assert.match(r.stdout, /console differs: src\/a.ts/);                 // reported, not applied by default
  assert.doesNotMatch(r.stdout, /dist\/x.js/);                          // the image rebuilds dist
  assert.match(r.stdout, /reverie: 0 file\(s\) differ/);
  assert.equal(readFileSync(join(t.opt, "apps", "web", "src", "a.ts"), "utf8"), "image-a");
  const again = restore(t, "false");
  assert.match(again.stdout, /Summary: 0 to restore/);
});

test("restore: never replaces the OpenCode DB under a running OpenCode; applies image diffs on request", () => {
  const t = restoreTree();
  const running = restore(t, "true");
  assert.match(running.stdout, /an opencode process is running/);
  assert.equal(existsSync(join(t.home, ".local", "share", "opencode", "opencode.db")), false);
  const applied = restore(t, "true", "--force", "--apply-image-diffs");
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readFileSync(join(t.opt, "apps", "web", "src", "a.ts"), "utf8"), "live-a");
  assert.ok(readdirSync(join(t.opt, "apps", "web", "src")).some((n) => n.startsWith("a.ts.pre-restore-")));
  assert.equal(readFileSync(join(t.home, ".local", "share", "opencode", "opencode.db"), "utf8"), "opencode.db");
});

test("engine storage defaults outside scratch, is printed, and REVERIE_SCRATCH still overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "reverie-storage-"));
  const fake = join(root, "podman");
  writeFileSync(fake, `#!${BASH}
echo "$*" >> "$(dirname "$0")/podman.log"
case "$*" in *"info --format"*) echo true ;; *"container exists"*) exit 1 ;; esac
`);
  chmodSync(fake, 0o755);
  const run = (extra) => spawnSync("bash", [join(scripts, "reverie-container"), "up"], {
    env: { PATH: process.env.PATH, HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data"), XDG_RUNTIME_DIR: join(root, "run"),
      REVERIE_PODMAN: fake, REVERIE_REPO: resolve(scripts, ".."), REVERIE_MEMORY: "6g", ...extra },
    encoding: "utf8",
  });
  const plain = run({});
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stderr, new RegExp(`Engine storage: ${join(root, "home", "reverie", "runtime", "engine")}`));
  assert.match(readFileSync(join(root, "podman.log"), "utf8"), new RegExp(`--root ${join(root, "home", "reverie", "runtime", "engine", "containers-overlay")}`));
  assert.equal(existsSync(join(root, "home", "scratch", "reverie", "engine")), false);
  const rooted = run({ REVERIE_ROOT: join(root, "selected-root") });
  assert.match(rooted.stderr, new RegExp("Engine storage: " + join(root, "selected-root", "runtime", "engine")));
  const custom = run({ REVERIE_SCRATCH: join(root, "custom") });
  assert.match(custom.stderr, new RegExp(`Engine storage: ${join(root, "custom")}`));
});
