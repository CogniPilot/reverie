/** One metadata-only choice inside the actual provider namespace, before exec.
 * Python3 is supplied by the native/worker runtime. Remote hosts without it
 * refuse before the provider; no host lookup or installation is substituted.
 */
export interface ClaudeResumeCommand { id: string; command: string; }
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Public source, also exercised with errno-injecting owned fixture ports. */
export const CLAUDE_METADATA_SELECTOR = String.raw`
import errno, json, os, shlex, signal, stat, sys, time
from pathlib import Path

class MetadataUnknown(Exception):
    pass

def _missing(path):
    # ENOENT under a dangling selected-account ancestor is UNKNOWN, not absence.
    path = Path(path)
    missing = False
    while True:
        try:
            value = path.lstat()
        except FileNotFoundError:
            missing = True
            parent = path.parent
            if parent == path:
                raise MetadataUnknown()
            path = parent
            continue
        if not missing or not stat.S_ISDIR(path.stat().st_mode):
            raise MetadataUnknown()
        return True

def _select(config, candidates, scandir=os.scandir, observe=os.stat, readable=os.access):
    if len(candidates) > 3:
        raise MetadataUnknown()
    projects = Path(config) / 'projects'
    directories = []
    try:
        with scandir(projects) as entries:
            for entry in entries:
                if len(directories) >= 4096:
                    raise MetadataUnknown()
                # Every root entry counts, including non-directories.
                directories.append(entry)
    except FileNotFoundError:
        if _missing(projects):
            return None
        raise MetadataUnknown()
    except OSError as error:
        raise MetadataUnknown() from error
    usable = []
    for entry in directories:
        try:
            value = entry.stat(follow_symlinks=True)
        except OSError as error:
            raise MetadataUnknown() from error
        if stat.S_ISDIR(value.st_mode):
            usable.append(Path(entry.path))
    for candidate in candidates:
        for directory in usable:
            path = directory / (candidate + '.jsonl')
            try:
                value = observe(path)
            except FileNotFoundError:
                # A dangling transcript link is not a missing transcript.
                if not directory.is_dir() or path.is_symlink():
                    raise MetadataUnknown()
                continue
            except OSError as error:
                raise MetadataUnknown() from error
            if not stat.S_ISREG(value.st_mode) or not readable(path, os.R_OK):
                raise MetadataUnknown()
            return candidate
    return None


# Selection only: POSIX timers interrupt ordinary metadata waits. Kernel D-state
# I/O can delay signal delivery; this is not a hard filesystem I/O deadline.
def _select_bounded(config, candidates, *, seconds=2.0, **ports):
    if not all(hasattr(signal, name) for name in
               ('SIGALRM', 'ITIMER_REAL', 'getitimer', 'setitimer',
                'pthread_sigmask', 'SIG_BLOCK', 'SIG_SETMASK', 'sigpending', 'sigwait')):
        raise MetadataUnknown()
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, [])
    if signal.SIGALRM in previous_mask:
        raise MetadataUnknown()
    previous_handler = signal.getsignal(signal.SIGALRM)
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise MetadataUnknown()
    deadline = time.monotonic() + seconds
    expired_seen = False
    cleaning = False
    def expired(_signum, _frame):
        nonlocal expired_seen
        expired_seen = True
        if not cleaning:
            raise MetadataUnknown()
    try:
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, seconds)
        selected = _select(config, candidates, **ports)
    finally:
        # Block BEFORE disarming: setitimer(0) alone leaves a queued alarm.
        # This private process owns no preexisting timer. Drain only SIGALRM;
        # a queued expiry refuses launch after handler AND mask are restored.
        cleaning = True
        signal.pthread_sigmask(signal.SIG_BLOCK, [signal.SIGALRM])
        try:
            signal.setitimer(signal.ITIMER_REAL, 0)
            while signal.SIGALRM in signal.sigpending():
                signal.sigwait({signal.SIGALRM})
                expired_seen = True
            signal.signal(signal.SIGALRM, previous_handler)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    if expired_seen or time.monotonic() >= deadline:
        raise MetadataUnknown()
    return selected

def main():
    try:
        plan = json.loads(sys.argv[1])
        home = os.environ.get('HOME')
        config = os.environ.get('CLAUDE_CONFIG_DIR')
        if not config:
            if not home:
                raise MetadataUnknown()
            config = str(Path(home) / '.claude')
        selected = _select_bounded(config, [row['id'] for row in plan['resumes']])
        command = next(row['command'] for row in plan['resumes'] if row['id'] == selected) if selected else plan['fresh']
        argv = shlex.split(command)
        if not argv:
            raise MetadataUnknown()
    except (MetadataUnknown, OSError, ValueError, KeyError, StopIteration):
        sys.stderr.write('Reverie: Claude transcript metadata unavailable; launch withheld.\n')
        return 78
    try:
        os.execvp(argv[0], argv)
    except FileNotFoundError:
        sys.stderr.write('Reverie: selected Claude executable unavailable.\n')
        return 127
    except OSError:
        sys.stderr.write('Reverie: selected Claude executable could not start.\n')
        return 126

if __name__ == '__main__':
    sys.exit(main())
`;

export function renderClaudeLaunch(resumes: readonly ClaudeResumeCommand[], fresh: string): string {
  const seen = new Set<string>();
  const candidates = resumes.filter(({ id }) => {
    if (!SAFE_ID.test(id) || seen.has(id)) return false;
    seen.add(id); return true;
  });
  const script = `command -v python3 >/dev/null 2>&1 || { printf '%s\\n' 'Reverie: Python3 is required to select the Claude transcript; launch withheld.' >&2; exit 78; }\nexec python3 -I -c ${quote(CLAUDE_METADATA_SELECTOR)} ${quote(JSON.stringify({ resumes: candidates, fresh }))}`;
  return `/bin/sh -c ${quote(script)}`;
}
