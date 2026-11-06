/** Installation-origin data for the native read/screen child. This is not a
 * session/employee/project grant. Only the final runtime bootstrap supplies it;
 * environment and MCP tool arguments cannot select an executable. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';

const SETTINGS = [
  'HOME',
  'REVERIE_ROOT',
  'REVERIE_PROTECTED_PEOPLE',
  'REVERIE_OUTPUT_POLICY',
  'REVERIE_API_BASE',
  'REVERIE_EMBED_URL',
  'REVERIE_EMBED_MODEL',
  'REVERIE_EMBED_DIMS',
  'REVERIE_EMBED_QUERY_PREFIX',
  'REVERIE_EMBED_DOC_PREFIX',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'REQUEST_METHOD',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

/** The final runtime owns console + native memory, avoiding a console→memory
 * build dependency cycle. This constructor checks its fixed package origin;
 * it neither creates boot state nor authenticates the surrounding MCP caller. */
export class InstalledMemoryBridge {
  private constructor(
    readonly executable: string,
    private readonly settings: Readonly<NodeJS.ProcessEnv>
  ) {
    Object.freeze(this);
  }

  static capture(executable: string, installation: NodeJS.ProcessEnv = process.env): InstalledMemoryBridge {
    if (
      process.platform !== 'linux' ||
      !/^\/nix\/store\/[a-z0-9]{32}-[^/]+\/bin\/reverie-memory$/.test(executable) ||
      realpathSync(executable) !== executable
    )
      throw new Error('Native memory package is unavailable');
    const fd = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let primary: unknown;
    try {
      const before = fstatSync(fd, { bigint: true });
      const bytes = Buffer.alloc(4);
      if (
        !before.isFile() ||
        before.uid !== 0n ||
        (before.mode & 0o222n) !== 0n ||
        (before.mode & 0o111n) === 0n ||
        readSync(fd, bytes, 0, 4, 0) !== 4 ||
        !bytes.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      )
        throw new Error('Native memory package is unavailable');
      const after = fstatSync(fd, { bigint: true });
      const named = lstatSync(executable, { bigint: true });
      for (const stat of [after, named]) {
        if (
          !stat.isFile() ||
          ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs'].some(
            (key) => stat[key as keyof typeof stat] !== before[key as keyof typeof before]
          )
        )
          throw new Error('Native memory package changed');
      }
    } catch (error) {
      primary = error;
    }
    try {
      closeSync(fd);
    } catch (error) {
      if (primary !== undefined)
        throw new AggregateError([primary, error], 'Native memory package validation and close failed');
      throw error;
    }
    if (primary !== undefined) throw primary;
    const selected: NodeJS.ProcessEnv = {};
    for (const key of SETTINGS) if (installation[key] !== undefined) selected[key] = installation[key];
    return new InstalledMemoryBridge(executable, Object.freeze(selected));
  }

  /** No credentials, parent/session headers, Node options or arbitrary process
   * settings cross into the native screen/read child. */
  environment(instance: string): NodeJS.ProcessEnv {
    return { ...this.settings, REVERIE_INSTANCE_CONFIG: instance };
  }
  /** The native installed-context mode reads its fixed guest file itself.
   * Preserve codepoint paths there; never roundtrip them through JS argv/env. */
  installedEnvironment(): NodeJS.ProcessEnv {
    return { ...this.settings };
  }
}
