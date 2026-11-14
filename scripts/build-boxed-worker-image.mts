/** Maintainer build adapter. Production runs the resulting image with Docker. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

type ObjectData = Record<string, unknown>;
interface Image {
  Id: string;
  Config: ObjectData;
  RootFS: { Type: string; Layers: string[] };
  Os: string;
  Architecture: string;
}
interface Member {
  path: string;
  sha256: string;
  bytes: number;
  mode: number;
}
const digest = /^[a-f0-9]{64}$/;
export function object(value: unknown): ObjectData {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as ObjectData;
}
export function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function capsuleMembers(raw: Buffer, expected: string): Member[] {
  assert(
    digest.test(expected) && sha(raw) === expected,
    "Capsule manifest digest differs",
  );
  const m = object(JSON.parse(raw.toString("utf8")));
  assert(m.version === 1 && m.purpose === "reverie-worker-client-v1");
  assert(
    m.entry === "/opt/reverie-worker-client/bin/reverie" &&
      m.node === "/opt/reverie-worker-client/bin/node",
  );
  return artifactMembers(m, 4096);
}
export function workerToolsMembers(raw: Buffer, expected: string): Member[] {
  assert(digest.test(expected) && sha(raw) === expected);
  const m = object(JSON.parse(raw.toString("utf8")));
  assert(m.version === 1 && m.purpose === "reverie-worker-tools-v1");
  assert(m.entry === "/opt/reverie-worker-tools/bin/tmux");
  assert(m.terminfo === "/opt/reverie-worker-tools/share/terminfo");
  assert(
    m.locale_archive ===
      "/opt/reverie-worker-tools/share/locale/locale-archive",
  );
  const members = artifactMembers(m, 8192);
  assert(members.some((f) => f.path === "bin/tmux" && f.mode === 0o555));
  assert(members.some((f) => f.path.startsWith("share/terminfo/")));
  assert(
    members.some(
      (f) => f.path === "share/locale/locale-archive" && f.mode === 0o444,
    ),
  );
  return members;
}
function artifactMembers(m: ObjectData, maximum: number): Member[] {
  assert(
    Array.isArray(m.files) && m.files.length > 0 && m.files.length <= maximum,
  );
  let previous = "";
  return m.files.map((value: unknown) => {
    const f = object(value);
    assert(
      typeof f.path === "string" &&
        f.path.length <= 4096 &&
        !f.path.includes("\\"),
    );
    assert(
      f.path
        .split("/")
        .every(
          (part) =>
            /^[A-Za-z0-9_.+-]+$/.test(part) && part !== "." && part !== "..",
        ),
    );
    assert(
      f.path > previous && f.path !== "manifest.json",
      "Duplicate or unordered capsule member",
    );
    previous = f.path;
    assert(typeof f.sha256 === "string" && digest.test(f.sha256));
    assert(
      typeof f.bytes === "number" &&
        Number.isSafeInteger(f.bytes) &&
        f.bytes >= 0 &&
        f.bytes <= 256 * 1024 ** 2,
    );
    assert(
      f.mode === 0o444 || f.mode === 0o555,
      "Unsupported capsule permissions",
    );
    return f as unknown as Member;
  });
}
export function qualifiedImage(value: unknown): Image {
  const x = object(value);
  assert(typeof x.Id === "string" && /^sha256:[a-f0-9]{64}$/.test(x.Id));
  object(x.Config);
  const root = object(x.RootFS);
  assert(root.Type === "layers" && Array.isArray(root.Layers));
  assert(
    root.Layers.length > 0 &&
      root.Layers.length <= 125 &&
      root.Layers.every(
        (x) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/.test(x),
      ),
  );
  assert(
    x.Os === "linux" && x.Architecture === "amd64",
    "Only qualified Linux amd64 artifacts supported",
  );
  return x as unknown as Image;
}
export function verifyOverlay(
  base: Image,
  target: Image,
  manifest: string,
  toolsManifest?: string,
): void {
  const expected = {
    ...base.Config,
    Env: toolsManifest
      ? toolsEnvironment(base.Config.Env)
      : workerEnvironment(base.Config.Env),
    Labels: {
      ...(base.Config.Labels as ObjectData | undefined),
      "org.reverie.worker-client.manifest": manifest,
      ...(toolsManifest
        ? { "org.reverie.worker-tools.manifest": toolsManifest }
        : {}),
    },
  };
  assert(
    isDeepStrictEqual(target.Config, expected),
    "Worker configuration changed outside capsule label",
  );
  assert(
    target.RootFS.Layers.length > base.RootFS.Layers.length &&
      target.RootFS.Layers.length <= 125,
  );
  assert(
    isDeepStrictEqual(
      target.RootFS.Layers.slice(0, base.RootFS.Layers.length),
      base.RootFS.Layers,
    ),
    "Source RootFS prefix changed",
  );
  assert(target.Os === base.Os && target.Architecture === base.Architecture);
}
export function workerEnvironment(value: unknown): string[] {
  assert(
    Array.isArray(value) && value.every((entry) => typeof entry === "string"),
  );
  assert(
    value.filter((entry: string) => entry.startsWith("PATH=")).length === 1,
    "One original PATH required",
  );
  return (value as string[]).map((entry) =>
    entry.startsWith("PATH=") &&
    !entry.startsWith("PATH=/opt/reverie-worker-client/bin:")
      ? "PATH=/opt/reverie-worker-client/bin:" + entry.slice(5)
      : entry,
  );
}
export function toolsEnvironment(value: unknown): string[] {
  return [
    ...workerEnvironment(value).filter(
      (entry) =>
        !entry.startsWith("TERMINFO=") &&
        !entry.startsWith("TERMINFO_DIRS=") &&
        !entry.startsWith("LOCALE_ARCHIVE="),
    ),
    "TERMINFO=/opt/reverie-worker-tools/share/terminfo",
    "TERMINFO_DIRS=/opt/reverie-worker-tools/share/terminfo",
    "LOCALE_ARCHIVE=/opt/reverie-worker-tools/share/locale/locale-archive",
  ];
}
function fixedFile(root: string, relative: string, maximum: number): Buffer {
  const parts = relative.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const s = fs.lstatSync(current);
    assert(
      s.isDirectory() && !s.isSymbolicLink(),
      "Capsule directory symlink refused",
    );
  }
  const filename = path.join(root, relative);
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    assert(before.isFile() && before.size <= BigInt(maximum));
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    assert(
      ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"].every(
        (key) =>
          before[key as keyof typeof before] ===
          after[key as keyof typeof after],
      ) && bytes.length <= maximum,
      "Artifact changed during read",
    );
    const named = fs.lstatSync(filename, { bigint: true });
    assert(
      named.dev === before.dev &&
        named.ino === before.ino &&
        !named.isSymbolicLink(),
      "Artifact name changed",
    );
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function writePrivate(filename: string, data: unknown): void {
  const fd = fs.openSync(filename, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function copyFile(
  context: string,
  relative: string,
  bytes: Buffer,
  mode: number,
): void {
  const destination = path.join(context, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.writeFileSync(destination, bytes, { flag: "wx", mode });
  fs.chmodSync(destination, mode);
  fs.utimesSync(destination, 1, 1);
}
export function sealCapsuleDirectories(
  root: string,
  members: readonly Member[],
): void {
  const directories = new Set([root]);
  for (const member of members) {
    let current = path.dirname(path.join(root, member.path));
    while (current !== root) {
      assert(current.startsWith(root + path.sep));
      directories.add(current);
      current = path.dirname(current);
    }
  }
  for (const directory of [...directories].sort().reverse()) {
    const before = fs.lstatSync(directory);
    assert(before.isDirectory() && !before.isSymbolicLink());
    fs.chmodSync(directory, 0o555);
    fs.utimesSync(directory, 1, 1);
  }
}
export async function build(argv: string[]): Promise<void> {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!,
      v = argv[i + 1];
    assert(k.startsWith("--") && v && !options.has(k));
    options.set(k, v);
  }
  const take = (key: string) => {
    const value = options.get(key);
    assert(value, "Required " + key);
    options.delete(key);
    return value;
  };
  const tools = options.get("--tools"),
    toolsDigest = options.get("--tools-digest");
  options.delete("--tools");
  options.delete("--tools-digest");
  assert((tools === undefined) === (toolsDigest === undefined));
  const docker = take("--docker"),
    baseId = take("--source-image"),
    capsule = take("--capsule"),
    manifest = take("--client-digest"),
    helper = take("--helper"),
    context = take("--context"),
    evidence = take("--evidence"),
    tag = take("--tag");
  assert(
    options.size === 0 &&
      /^sha256:[a-f0-9]{64}$/.test(baseId) &&
      digest.test(manifest),
  );
  assert(/^[a-z0-9][a-z0-9_./-]*:[a-z0-9][a-z0-9_.-]*$/.test(tag));
  for (const p of [docker, capsule, helper, context, evidence])
    assert(path.isAbsolute(p));
  assert(
    fs.lstatSync(capsule).isDirectory() &&
      !fs.lstatSync(capsule).isSymbolicLink(),
  );
  if (tools) {
    assert(path.isAbsolute(tools));
    const info = fs.lstatSync(tools);
    assert(info.isDirectory() && !info.isSymbolicLink());
  }
  const rawManifest = fixedFile(capsule, "manifest.json", 4 * 1024 ** 2),
    members = capsuleMembers(rawManifest, manifest);
  const payloads = members.map((member) => {
    const bytes = fixedFile(capsule, member.path, 256 * 1024 ** 2);
    assert(bytes.length === member.bytes && sha(bytes) === member.sha256);
    const stat = fs.lstatSync(path.join(capsule, member.path));
    assert((stat.mode & 0o7777) === member.mode);
    return { member, bytes };
  });
  const toolManifest = tools
    ? fixedFile(tools, "manifest.json", 4 * 1024 ** 2)
    : undefined;
  const toolMembers = toolManifest
    ? workerToolsMembers(toolManifest, toolsDigest!)
    : [];
  const toolPayloads = toolMembers.map((member) => {
    const bytes = fixedFile(tools!, member.path, 256 * 1024 ** 2);
    assert(bytes.length === member.bytes && sha(bytes) === member.sha256);
    assert(
      (fs.lstatSync(path.join(tools!, member.path)).mode & 0o7777) ===
        member.mode,
    );
    return { member, bytes };
  });
  const helperBytes = fixedFile(
    path.dirname(helper),
    path.basename(helper),
    16 * 1024 ** 2,
  );
  assert(helperBytes.subarray(0, 4).toString("hex") === "7f454c46");
  fs.mkdirSync(context, { mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  copyFile(
    context,
    "opt/reverie-worker-client/manifest.json",
    rawManifest,
    0o444,
  );
  for (const { member, bytes } of payloads)
    copyFile(
      context,
      "opt/reverie-worker-client/" + member.path,
      bytes,
      member.mode,
    );
  copyFile(
    context,
    "opt/reverie-worker-tools/reverie-docker-resources",
    helperBytes,
    0o555,
  );
  if (toolManifest) {
    copyFile(
      context,
      "opt/reverie-worker-tools/manifest.json",
      toolManifest,
      0o444,
    );
    for (const { member, bytes } of toolPayloads)
      copyFile(
        context,
        "opt/reverie-worker-tools/" + member.path,
        bytes,
        member.mode,
      );
    sealCapsuleDirectories(
      path.join(context, "opt/reverie-worker-tools"),
      toolMembers,
    );
  }
  const entry = payloads.find((x) => x.member.path === "bin/reverie");
  assert(entry && entry.member.mode === 0o555);
  const dockerfile = fileURLToPath(
    new URL(
      tools
        ? "../docker/Dockerfile.worker-tools"
        : "../docker/Dockerfile.boxed-worker",
      import.meta.url,
    ),
  );
  copyFile(context, "Dockerfile", fs.readFileSync(dockerfile), 0o444);
  sealCapsuleDirectories(
    path.join(context, "opt/reverie-worker-client"),
    members,
  );
  let sequence = 0;
  async function command(args: string[]): Promise<string> {
    const n = ++sequence;
    writePrivate(path.join(evidence, `${n}-intent.json`), { args });
    const result = await new Promise<{
      code: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(docker, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "",
        stderr = "",
        killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
      }, 240_000);
      child.stdout.on("data", (b) => {
        stdout += b;
        if (stdout.length > 4 * 1024 ** 2) {
          killed = true;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (b) => {
        stderr += b;
        if (stderr.length > 4 * 1024 ** 2) {
          killed = true;
          child.kill("SIGTERM");
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          code,
          signal: killed ? (signal ?? "bounded") : signal,
          stdout,
          stderr,
        });
      });
    });
    writePrivate(path.join(evidence, `${n}-result.json`), result);
    assert(
      result.code === 0 && result.signal === null,
      "Docker command failed or unconfirmed",
    );
    return result.stdout;
  }
  async function image(id: string): Promise<Image> {
    const values = JSON.parse(
      await command(["image", "inspect", id]),
    ) as unknown[];
    assert(Array.isArray(values) && values.length === 1);
    return qualifiedImage(values[0]);
  }
  const base = await image(baseId);
  assert(base.Id === baseId);
  assert(
    /^Driver:\s+docker\s*$/m.test(
      await command(["buildx", "inspect", "default"]),
    ),
    "A native Docker builder is required",
  );
  const alias = "reverie-boxed-source:" + randomBytes(16).toString("hex");
  writePrivate(path.join(evidence, "plan.json"), {
    baseId,
    base,
    alias,
    tag,
    manifest,
    toolsDigest,
    helperSHA256: sha(helperBytes),
    members,
  });
  await command(["image", "tag", baseId, alias]);
  assert((await image(alias)).Id === baseId);
  const toolArgs = toolsDigest
    ? ["--build-arg", "REVERIE_TOOLS_MANIFEST=" + toolsDigest]
    : [];
  await command([
    "buildx",
    "build",
    "--builder",
    "default",
    "--pull=false",
    "--network=none",
    "--load",
    "--progress=plain",
    "--build-arg",
    "REVERIE_WORKER_BASE=" + alias,
    "--build-arg",
    "REVERIE_CLIENT_MANIFEST=" + manifest,
    "--build-arg",
    "REVERIE_WORKER_PATH=" +
      workerEnvironment(base.Config.Env)
        .find((entry) => entry.startsWith("PATH="))!
        .slice(5),
    "--build-arg",
    "SOURCE_DATE_EPOCH=1",
    ...toolArgs,
    "--iidfile",
    path.join(context, "image-id"),
    "--tag",
    tag,
    context,
  ]);
  const id = fs.readFileSync(path.join(context, "image-id"), "utf8").trim();
  assert(/^sha256:[a-f0-9]{64}$/.test(id));
  const target = await image(id);
  assert(
    (await image(tag)).Id === id &&
      (await image(alias)).Id === baseId &&
      (await image(baseId)).Id === baseId,
  );
  verifyOverlay(base, target, manifest, toolsDigest);
  writePrivate(path.join(evidence, "result.json"), {
    qualified: true,
    baseImageId: baseId,
    imageId: id,
    clientManifestDigest: manifest,
    workerToolsManifestDigest: toolsDigest,
    helperSHA256: sha(helperBytes),
    config: target.Config,
    rootFS: target.RootFS,
    immutableInputsOnly: true,
    providerReady: false,
  });
  console.log(
    JSON.stringify({
      qualified: true,
      imageId: id,
      clientManifestDigest: manifest,
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await build(process.argv.slice(2));
