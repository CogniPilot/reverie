/**
 * @fileoverview The office's own copy of one plan sign-in, as a holder the reconciler can read and repair.
 *
 * The file is the office's (`<account folder>/.credentials.json`, mode 0600). It is only ever replaced, never
 * created: an office that is signed out of a plan stays signed out. A replacement is written whole under a private
 * name in the same folder and renamed into place, only while the file is still the one that was read and the
 * office's own Claude client is not renewing it. Nothing here logs, and no error carries file content.
 */
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { SignInHolderPort, SignInWriteOutcome } from './plan-signin-reconciler.js';
import { SIGN_IN_FILE_LIMIT, signInView, type SignInView } from './plan-signin-sync.js';

const NAME = '.credentials.json';
const PENDING = NAME + '.reverie-sync';
/** The Claude client holds this lock folder while it renews; one it stopped updating a minute ago is lost. */
const LOCK = '.oauth_refresh.lock';
const LOCK_FRESH_MS = 60_000;

export class OfficeSignInCopy implements SignInHolderPort {
  readonly id = 'office';
  readonly office = true;
  readonly label = 'the office';

  /** `folder` answers the plan account's real folder, or `undefined` when the office no longer lists that plan. */
  constructor(private readonly folder: () => Promise<string | undefined>) {}

  /** The file's text; `null` when there is no file; `undefined` when it is not a plain private file of bounded size. */
  async #text(dir: string): Promise<string | null | undefined> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(join(dir, NAME), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > SIGN_IN_FILE_LIMIT) return undefined;
      const bytes = await handle.readFile();
      const text = bytes.toString('utf8');
      // Bytes that are not text have no reading the laptop side would share.
      return Buffer.from(text).equals(bytes) ? text : undefined;
    } catch {
      return undefined;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async observe(): Promise<SignInView | undefined> {
    const dir = await this.folder();
    if (!dir) return undefined;
    const text = await this.#text(dir);
    return text === undefined ? undefined : signInView(text ?? undefined);
  }

  async read(digest: string): Promise<string | undefined> {
    const dir = await this.folder();
    if (!dir) return undefined;
    const text = await this.#text(dir);
    return typeof text === 'string' && signInView(text).digest === digest ? text : undefined;
  }

  async write(text: string, expected: SignInView): Promise<SignInWriteOutcome> {
    if (signInView(text).state !== 'usable' || Buffer.byteLength(text) > SIGN_IN_FILE_LIMIT) return 'refused';
    // Never created here: only a file that exists is repaired.
    if (expected.digest === undefined) return 'refused';
    const dir = await this.folder();
    if (!dir) return 'refused';
    const unchanged = async () => {
      const now = await this.#text(dir);
      return typeof now === 'string' && signInView(now).digest === expected.digest;
    };
    if (!(await unchanged())) return 'changed';
    try {
      if (Date.now() - (await fs.lstat(join(dir, LOCK))).mtimeMs < LOCK_FRESH_MS) return 'busy';
    } catch {
      /* No lock: no renewal is running. */
    }
    const pending = join(dir, PENDING);
    try {
      await fs.rm(pending, { force: true });
      const handle = await fs.open(
        pending,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(text, 'utf8');
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!(await unchanged())) {
        await fs.rm(pending, { force: true });
        return 'changed';
      }
      await fs.rename(pending, join(dir, NAME));
      const folder = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
      return 'written';
    } catch {
      await fs.rm(pending, { force: true }).catch(() => {});
      return 'refused';
    }
  }
}
