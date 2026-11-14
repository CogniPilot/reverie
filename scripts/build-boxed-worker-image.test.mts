import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capsuleMembers,
  sha,
  qualifiedImage,
  verifyOverlay,
  sealCapsuleDirectories,
  workerEnvironment,
  toolsEnvironment,
  workerToolsMembers,
} from "./build-boxed-worker-image.mts";

test("capsule directories are sealed to the producer's required 0555 before COPY", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reverie-capsule-modes-"));
  const member = {
    path: "bin/reverie",
    sha256: "0".repeat(64),
    bytes: 1,
    mode: 0o555,
  };
  fs.mkdirSync(path.join(root, "bin"), { mode: 0o755 });
  try {
    sealCapsuleDirectories(root, [member]);
    assert.equal(fs.statSync(root).mode & 0o777, 0o555);
    assert.equal(fs.statSync(path.join(root, "bin")).mode & 0o777, 0o555);
  } finally {
    fs.chmodSync(root, 0o700);
    fs.chmodSync(path.join(root, "bin"), 0o700);
    fs.rmSync(root, { recursive: true });
  }
});
const imageId = "sha256:" + "a".repeat(64),
  layer = "sha256:" + "b".repeat(64),
  manifest = "c".repeat(64);
const base = () =>
  qualifiedImage({
    Id: imageId,
    Config: {
      Env: ["PATH=/bin"],
      User: "1000:100",
      Entrypoint: ["/bin/sleep"],
      Cmd: ["infinity"],
      Labels: { original: "preserved" },
    },
    RootFS: { Type: "layers", Layers: [layer] },
    Os: "linux",
    Architecture: "amd64",
  });
const target = () => ({
  ...base(),
  Id: "sha256:" + "d".repeat(64),
  Config: {
    ...base().Config,
    Env: ["PATH=/opt/reverie-worker-client/bin:/bin"],
    Labels: {
      original: "preserved",
      "org.reverie.worker-client.manifest": manifest,
    },
  },
  RootFS: { Type: "layers", Layers: [layer, "sha256:" + "e".repeat(64)] },
});
test("only selected PATH changes; other environment bytes and order survive", () => {
  assert.deepEqual(
    workerEnvironment(["HOME=/home/agent", "PATH=/bin:/usr/bin", "KEEP=a=b"]),
    [
      "HOME=/home/agent",
      "PATH=/opt/reverie-worker-client/bin:/bin:/usr/bin",
      "KEEP=a=b",
    ],
  );
  assert.throws(() => workerEnvironment(["PATH=/bin", "PATH=/tmp"]));
  assert.throws(() => workerEnvironment(["HOME=/home/agent"]));
});
function encoded(files: unknown[]) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      purpose: "reverie-worker-client-v1",
      entry: "/opt/reverie-worker-client/bin/reverie",
      node: "/opt/reverie-worker-client/bin/node",
      files,
    }),
  );
}
const file = () => ({
  path: "bin/reverie",
  sha256: "0".repeat(64),
  bytes: 1,
  mode: 0o555,
});
test("qualified overlay preserves full source configuration and complete ordered RootFS prefix", () => {
  assert.doesNotThrow(() => verifyOverlay(base(), target(), manifest));
});
test("different source layer or reordered prefix refuses", () => {
  const value = target();
  value.RootFS.Layers.reverse();
  assert.throws(() => verifyOverlay(base(), value, manifest));
});
test("provider environment or identity changes refuse even with expected client label", () => {
  for (const delta of [
    { Env: ["PATH=/tmp"] },
    { User: "0:0" },
    { Entrypoint: ["/bin/sh"] },
    { Cmd: ["changed"] },
  ]) {
    assert.throws(() =>
      verifyOverlay(
        base(),
        { ...target(), Config: { ...target().Config, ...delta } },
        manifest,
      ),
    );
  }
});
test("unexpected label changes refuse", () => {
  const value = target();
  value.Config.Labels.original = "changed";
  assert.throws(() => verifyOverlay(base(), value, manifest));
});
test("wrong architecture and malformed immutable IDs refuse", () => {
  assert.throws(() => qualifiedImage({ ...base(), Architecture: "arm64" }));
  assert.throws(() => qualifiedImage({ ...base(), Id: "latest" }));
});
test("canonical capsule artifact member admitted only by exact public manifest hash", () => {
  const raw = encoded([file()]);
  assert.equal(capsuleMembers(raw, sha(raw)).length, 1);
  assert.throws(() => capsuleMembers(raw, "f".repeat(64)));
});
test("capsule path traversal, absolute names, duplicate entries and writable modes refuse", () => {
  for (const files of [
    [{ ...file(), path: "../private" }],
    [{ ...file(), path: "/etc/token" }],
    [file(), file()],
    [{ ...file(), mode: 0o777 }],
    [{ ...file(), bytes: 300 * 1024 ** 2 }],
  ]) {
    const raw = encoded(files);
    assert.throws(() => capsuleMembers(raw, sha(raw)));
  }
});

test("trusted tools preserve existing client PATH and pin terminal data", () => {
  assert.deepEqual(
    toolsEnvironment([
      "PATH=/opt/reverie-worker-client/bin:/bin",
      "KEEP=value",
      "TERMINFO=/nix/mutable",
    ]),
    [
      "PATH=/opt/reverie-worker-client/bin:/bin",
      "KEEP=value",
      "TERMINFO=/opt/reverie-worker-tools/share/terminfo",
      "TERMINFO_DIRS=/opt/reverie-worker-tools/share/terminfo",
      "LOCALE_ARCHIVE=/opt/reverie-worker-tools/share/locale/locale-archive",
    ],
  );
});
test("worker tools require their own fixed manifest roles", () => {
  const raw = Buffer.from(
    JSON.stringify({
      version: 1,
      purpose: "reverie-worker-tools-v1",
      entry: "/opt/reverie-worker-tools/bin/tmux",
      terminfo: "/opt/reverie-worker-tools/share/terminfo",
      locale_archive: "/opt/reverie-worker-tools/share/locale/locale-archive",
      files: [
        { path: "bin/tmux", sha256: "a".repeat(64), bytes: 1, mode: 0o555 },
        {
          path: "share/locale/locale-archive",
          sha256: "c".repeat(64),
          bytes: 1,
          mode: 0o444,
        },
        {
          path: "share/terminfo/x/xterm",
          sha256: "b".repeat(64),
          bytes: 1,
          mode: 0o444,
        },
      ],
    }),
  );
  assert.equal(workerToolsMembers(raw, sha(raw)).length, 3);
  assert.throws(() => capsuleMembers(raw, sha(raw)));
});
