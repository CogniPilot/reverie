/** Select only a completed Cargo build's exact owned host-test artifact. */
import { accessSync, constants, lstatSync, openSync, readSync, closeSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Cargo JSON record');
  return value as Record<string, unknown>;
}
function contained(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}
export function selectNativeHookHostTest(source: string, repoRoot: string, targetRoot: string): string {
  const repo = resolve(repoRoot),
    target = resolve(targetRoot);
  const rows = source
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => record(JSON.parse(line) as unknown));
  if (rows.some((row) => row.reason === 'compiler-message' && record(row.message).level === 'error'))
    throw new Error('Cargo stream contains a compiler error');
  const completed = rows.filter((row) => row.reason === 'build-finished');
  if (completed.length !== 1 || completed[0] !== rows.at(-1) || completed[0].success !== true)
    throw new Error('Cargo stream did not finish exactly once with success');
  const manifest = join(repo, 'crates/reverie-host/Cargo.toml'),
    lib = join(repo, 'crates/reverie-host/src/lib.rs');
  const candidates = rows.filter((row) => {
    if (row.reason !== 'compiler-artifact' || row.manifest_path !== manifest) return false;
    const kind = record(row.target),
      profile = record(row.profile);
    return (
      kind.name === 'reverie_host' &&
      kind.src_path === lib &&
      kind.test === true &&
      Array.isArray(kind.kind) &&
      kind.kind.length === 1 &&
      kind.kind[0] === 'lib' &&
      profile.test === true
    );
  });
  if (candidates.length !== 1) throw new Error('Expected exactly one host library test artifact');
  const artifact = candidates[0],
    executable = artifact.executable;
  if (
    typeof artifact.package_id !== 'string' ||
    !artifact.package_id.startsWith(
      pathToFileURL(join(repo, 'crates/reverie-host')).href.replace(/^file:/, 'path+file:') + '#'
    ) ||
    typeof executable !== 'string' ||
    !isAbsolute(executable) ||
    resolve(executable) !== executable ||
    !contained(target, executable) ||
    !Array.isArray(artifact.filenames) ||
    !artifact.filenames.includes(executable)
  )
    throw new Error('Host test artifact identity or target path is invalid');
  return executable;
}
export function checkedNativeHookHostTest(source: string, repoRoot: string, targetRoot: string): string {
  const target = realpathSync(targetRoot),
    executable = selectNativeHookHostTest(source, realpathSync(repoRoot), target);
  if (!lstatSync(executable).isFile() || !contained(target, realpathSync(executable)))
    throw new Error('Host test artifact must be a regular file inside the canonical target');
  accessSync(executable, constants.X_OK);
  const fd = openSync(executable, 'r');
  try {
    const magic = Buffer.alloc(4);
    if (
      readSync(fd, magic, 0, magic.length, 0) !== magic.length ||
      !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    )
      throw new Error('Host test artifact is not an ELF executable');
  } finally {
    closeSync(fd);
  }
  return executable;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) throw new Error('Expected repository, Cargo target and fresh Cargo JSONL paths');
    const input = process.argv[4];
    if (!lstatSync(input).isFile() || lstatSync(input).size > 16 * 1024 * 1024)
      throw new Error('Invalid Cargo JSONL input');
    console.log(checkedNativeHookHostTest(readFileSync(input, 'utf8'), process.argv[2], process.argv[3]));
  } catch (error) {
    console.error(`Native hook artifact selection failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
