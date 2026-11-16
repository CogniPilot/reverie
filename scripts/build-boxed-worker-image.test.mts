import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  capsuleMembers,
  sha,
  qualifiedImage,
  verifyOverlay,
  sealCapsuleDirectories,
  workerEnvironment,
  toolsEnvironment,
  workerToolsMembers,
  capsuleReplacementArguments,
  build,
} from "./build-boxed-worker-image.mts";
import { fileURLToPath } from "node:url";

test("both fixed Dockerfiles replace the entire client tree before COPY and restore the inspected user", () => {
  for (const name of ["Dockerfile.boxed-worker", "Dockerfile.worker-tools"]) {
    const lines = fs
      .readFileSync(
        fileURLToPath(new URL("../docker/" + name, import.meta.url)),
        "utf8",
      )
      .split("\n")
      .map((line) => line.trim());
    const root = lines.indexOf("USER 0:0"),
      remove = lines.findIndex((line) => line.startsWith("RUN ")),
      copy = lines.indexOf("COPY --chown=0:0 opt/ /opt/"),
      restored = lines.indexOf("USER ${REVERIE_WORKER_USER}");
    assert(lines.indexOf("ARG REVERIE_WORKER_USER") < root);
    assert(root > 0 && root < remove && remove < copy && copy < restored);
    assert.equal(lines.filter((line) => line.startsWith("RUN ")).length, 1);
    assert.deepEqual(JSON.parse(lines[remove]!.slice(4)), [
      "/bin/rm",
      "-rf",
      "--",
      "/opt/reverie-worker-client",
    ]);
    assert.equal(lines.filter((line) => line.startsWith("USER ")).length, 2);
  }
});
test("only the exact canonical inspected UID:GID enters the fixed restoration argument", () => {
  for (const user of ["1000:100", "0:0", "4294967294:4294967294"])
    assert.deepEqual(capsuleReplacementArguments(user), [
      "--build-arg",
      "REVERIE_WORKER_USER=" + user,
    ]);
  for (const user of [
    undefined,
    null,
    "",
    "root",
    "1000",
    "01:2",
    "1:02",
    "-1:2",
    "1:4294967295",
    "1:2\n",
    "1:2;id",
    "$(id):2",
    {},
    [],
  ])
    assert.throws(() => capsuleReplacementArguments(user));
});

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

test("actual adapter refuses an unsupported source user before the first image mutation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reverie-source-user-"));
  const capsule = path.join(root, "capsule"),
    helper = path.join(root, "helper");
  fs.mkdirSync(path.join(capsule, "bin"), { recursive: true });
  const bytes = Buffer.from("owned-test-entry");
  const member = { ...file(), sha256: sha(bytes), bytes: bytes.length };
  const raw = encoded([member]);
  fs.writeFileSync(path.join(capsule, "manifest.json"), raw, { mode: 0o444 });
  fs.writeFileSync(path.join(capsule, member.path), bytes, {
    mode: member.mode,
  });
  fs.writeFileSync(helper, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const calls: string[][] = [];
  const original = childProcess.spawn;
  try {
    // Negative-only native port: no Docker executable or daemon is contacted.
    childProcess.spawn = ((command: string, args: readonly string[] = []) => {
      assert.equal(command, path.join(root, "docker"));
      calls.push([...args]);
      assert.deepEqual(args, ["image", "inspect", imageId]);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      queueMicrotask(() => {
        child.stdout.end(
          JSON.stringify([
            { ...base(), Config: { ...base().Config, User: "" } },
          ]),
        );
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof childProcess.spawn;
    syncBuiltinESMExports();
    await assert.rejects(
      build([
        "--docker",
        path.join(root, "docker"),
        "--source-image",
        imageId,
        "--capsule",
        capsule,
        "--client-digest",
        sha(raw),
        "--helper",
        helper,
        "--context",
        path.join(root, "context"),
        "--evidence",
        path.join(root, "evidence"),
        "--tag",
        "reverie-test:owned",
      ]),
      /canonical numeric source UID:GID/,
    );
    assert.deepEqual(calls, [["image", "inspect", imageId]]);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    function writable(directory: string) {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) writable(path.join(directory, entry.name));
    }
    writable(root);
    fs.rmSync(root, { recursive: true });
  }
});
