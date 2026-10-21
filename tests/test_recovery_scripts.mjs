// Run with node --test tests/test_recovery_scripts.mjs. Fake engine only: no podman, no host changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("CODEMAN_") || key.startsWith("FLEET_")) delete process.env[key];
}
const scripts = resolve(import.meta.dirname, "..", "scripts");

// A launcher stand-in: logs every call; the build snapshot records what the context held.
const FAKE_LAUNCHER = `#!/usr/bin/env bash
log="$(dirname "$0")/calls"
case "$1" in
  memory-default) echo 8g ;;
  build) { echo "build FLEET_IMAGE=$FLEET_IMAGE"; (cd "$FLEET_REPO" && find . -maxdepth 3 | sort | sed 's/^/ctx /'); \\
           echo "ctx-cto $(cat "$FLEET_REPO/cto/runtime.py")"; } >> "$log" ;;
  engine) shift; echo "engine $*" >> "$log"
          if [ "$1 $2" = "container exists" ]; then [ -f "$(dirname "$0")/exists" ]; fi ;;
  *) exit 9 ;;
esac
`;

function hostTree() {
  const root = mkdtempSync(join(tmpdir(), "reverie-recreate-"));
  const dirs = {
    root, home: join(root, "home"), repo: join(root, "repo"), scratch: join(root, "scratch"),
    instance: join(root, "instance"), bin: join(root, "bin"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  mkdirSync(join(dirs.scratch, "repos"));
  mkdirSync(join(dirs.instance, "config")); writeFileSync(join(dirs.instance, "config", "instance.json"), "{}");
  const rescue = join(dirs.scratch, "handoffs", "2026-10-15", "rescue");
  const console = join(rescue, "opt-console");
  mkdirSync(join(console, "src"), { recursive: true }); mkdirSync(join(console, "node_modules", "big"), { recursive: true });
  writeFileSync(join(console, "package.json"), "{}"); writeFileSync(join(console, "package-lock.json"), "{}");
  const cto = join(rescue, "opt-fleet-python", "site-packages", "cto");
  mkdirSync(cto, { recursive: true }); writeFileSync(join(cto, "runtime.py"), "rescued-runtime");
  writeFileSync(join(dirs.bin, "fleet-container"), FAKE_LAUNCHER); chmodSync(join(dirs.bin, "fleet-container"), 0o755);
  return { ...dirs, rescue };
}

function recreate(t, ...args) {
  const result = spawnSync("bash", [join(scripts, "reverie-recreate"), "--repo", t.repo, "--scratch", t.scratch,
    "--instance", t.instance, "--model", "test-model", "--api-base", "http://127.0.0.1:8080/v1", "--console-source", join(t.rescue, "opt-console"),
    "--cto-source", join(t.rescue, "opt-fleet-python", "site-packages", "cto"), ...args], {
    env: { PATH: process.env.PATH, HOME: t.home, TMPDIR: t.root, FLEET_LAUNCHER: join(t.bin, "fleet-container") },
    encoding: "utf8",
  });
  const calls = existsSync(join(t.bin, "calls")) ? readFileSync(join(t.bin, "calls"), "utf8").split("\n").filter(Boolean) : [];
  return { ...result, calls };
}

test("dry run prints the full, faithful container and changes nothing", () => {
  const t = hostTree();
  const r = recreate(t, "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  // printf %q escapes commas; compare the unescaped command line.
  const runLine = r.stdout.split("\n").find((l) => l.includes(" engine create ")).replace(/\\/g, "");
  const instanceTarget = /FLEET_INSTANCE_CONFIG=(\/instances\/[^ ]+)\/config\/instance\.json/.exec(runLine)?.[1];
  assert.ok(instanceTarget, "the private mount has an explicit instance config");
  for (const part of [`src=${t.repo},dst=/workspace`, `src=${t.scratch},dst=/scratch`, `src=${t.instance},dst=${instanceTarget}`,
    "create --pull=never --init --name reverie-live", "--user 2000:2000", "--userns=keep-id:uid=2000,gid=2000", "--cap-drop=all", "--memory=8g", "--memory-swap=8g",
    "--pids-limit=512", "--network=pasta:--map-host-loopback,169.254.1.2", "--publish 127.0.0.1:3001:3000",
    `FLEET_INSTANCE_CONFIG=${instanceTarget}/config/instance.json`, `FLEET_DATA_DIR=${instanceTarget}/runtime/console`,
    "FLEET_API_BASE=http://127.0.0.1:8080/v1", "FLEET_MODEL=test-model", "CODEMAN_API_URL=http://127.0.0.1:3000",
    "FLEET_API_URL=http://127.0.0.1:3000", "FLEET_CASES_PATH=/scratch/cases", "FLEET_RESEARCH_ROOT=/scratch/research",
    "localhost/reverie:live /usr/local/bin/reverie web --host 0.0.0.0 --port 3000 --allow-unauthenticated-network"]) {
    assert.ok(runLine.includes(part), `run line lacks ${part}: ${runLine}`);
  }
  assert.match(r.stdout, /DRY RUN/);
  assert.deepEqual(r.calls, ["engine container exists reverie-live"]);       // read-only query only
  assert.equal(readdirSync(t.root).some((n) => n.startsWith("reverie-build.")), false);
});

test("an existing container is refused unless --replace, which removes only the container", () => {
  const t = hostTree();
  writeFileSync(join(t.bin, "exists"), "");
  const refused = recreate(t);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /exists; pass --replace/);
  assert.deepEqual(refused.calls, ["engine container exists reverie-live"]);
  writeFileSync(join(t.bin, "calls"), "");
  const replaced = recreate(t, "--replace");
  assert.equal(replaced.status, 0, replaced.stderr);
  const order = replaced.calls.filter((c) => /^engine (stop|rm|run|create|start)|^build/.test(c)).map((c) => c.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(order, ["engine stop", "engine rm", "build FLEET_IMAGE=localhost/reverie:live", "engine create"]);
  assert.equal(replaced.calls.some((c) => / (rmi|volume|prune)\b| -v\b| --volumes\b/.test(c)), false);
  assert.ok(existsSync(join(t.instance, "config", "instance.json")));       // mounted data untouched
});

test("the image is built from the rescued console (without node_modules) and rescued cto", () => {
  const t = hostTree();
  const r = recreate(t);
  assert.equal(r.status, 0, r.stderr);
  const ctx = r.calls.filter((c) => c.startsWith("ctx "));
  assert.ok(ctx.includes("ctx ./apps/console/package.json"));
  assert.ok(ctx.includes("ctx ./docker") && ctx.includes("ctx ./pyproject.toml"));
  assert.equal(ctx.some((c) => c.includes("node_modules")), false);
  assert.ok(r.calls.includes("ctx-cto rescued-runtime"));
  assert.equal(readdirSync(t.root).some((n) => n.startsWith("reverie-build.")), false);   // context cleaned up
});

test("wrong or empty mount sources are refused before anything runs", () => {
  const t = hostTree();
  const noConfig = recreate(t, "--instance", t.home);
  assert.match(noConfig.stderr, /no config\/instance.json/);
  const badScratch = recreate(t, "--scratch", t.home);
  assert.match(badScratch.stderr, /no repos\//);
  const missing = recreate(t, "--repo", join(t.root, "nope"));
  assert.match(missing.stderr, /repo does not exist/);
  assert.deepEqual([noConfig, badScratch, missing].map((r) => r.calls.length), [0, 0, 0]);
});

test("publish options and launcher installation", () => {
  const t = hostTree();
  const two = recreate(t, "--dry-run", "--publish", "127.0.0.1:3000:3000", "--publish", "192.0.2.5:3000:3000");
  assert.match(two.stdout, /--publish 127.0.0.1:3000:3000 --publish 192.0.2.5:3000:3000/);
  assert.doesNotMatch(recreate(t, "--dry-run", "--no-publish").stdout, /--publish/);
  const installed = join(t.home, ".local", "libexec", "agent-fleet", "fleet-container");
  mkdirSync(join(t.home, ".local", "libexec", "agent-fleet"), { recursive: true }); writeFileSync(installed, "old");
  const r = recreate(t, "--no-build", "--install-launcher");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(installed + ".bak", "utf8"), "old");
  assert.equal(readFileSync(installed, "utf8"), readFileSync(join(scripts, "fleet-container"), "utf8"));
});

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
  write(join(opt, "apps", "console", "src", "a.ts"), "image-a"); write(join(opt, "apps", "console", "dist", "x.js"), "other-dist");
  write(join(rescue, "opt-fleet-python", "site-packages", "cto", "runtime.py"), "rt");
  write(join(opt, "python", "lib", "python3.11", "site-packages", "cto", "runtime.py"), "rt");
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
  assert.match(r.stdout, /cto: 0 file\(s\) differ/);
  assert.equal(readFileSync(join(t.opt, "apps", "console", "src", "a.ts"), "utf8"), "image-a");
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
  assert.equal(readFileSync(join(t.opt, "apps", "console", "src", "a.ts"), "utf8"), "live-a");
  assert.ok(readdirSync(join(t.opt, "apps", "console", "src")).some((n) => n.startsWith("a.ts.pre-restore-")));
  assert.equal(readFileSync(join(t.home, ".local", "share", "opencode", "opencode.db"), "utf8"), "opencode.db");
});

test("engine storage defaults outside scratch, is printed, and FLEET_SCRATCH still overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "reverie-storage-"));
  const fake = join(root, "podman");
  writeFileSync(fake, `#!/usr/bin/env bash
echo "$*" >> "$(dirname "$0")/podman.log"
case "$*" in *"info --format"*) echo true ;; *"container exists"*) exit 1 ;; esac
`);
  chmodSync(fake, 0o755);
  const run = (extra) => spawnSync("bash", [join(scripts, "fleet-container"), "up"], {
    env: { PATH: process.env.PATH, HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data"), XDG_RUNTIME_DIR: join(root, "run"),
      FLEET_PODMAN: fake, FLEET_REPO: resolve(scripts, ".."), FLEET_MEMORY: "6g", ...extra },
    encoding: "utf8",
  });
  const plain = run({});
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stderr, new RegExp(`Engine storage: ${join(root, "data", "reverie", "engine")}`));
  assert.match(readFileSync(join(root, "podman.log"), "utf8"), new RegExp(`--root ${join(root, "data", "reverie", "engine", "containers-overlay")}`));
  assert.equal(existsSync(join(root, "home", "scratch", "agent-fleet")), false);
  const custom = run({ FLEET_SCRATCH: join(root, "custom") });
  assert.match(custom.stderr, new RegExp(`Engine storage: ${join(root, "custom")}`));
});
