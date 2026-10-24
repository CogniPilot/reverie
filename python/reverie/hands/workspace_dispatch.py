"""Coding tools: the dispatcher that runs in an agent laptop workspace.

One call per process. The runner starts it with a fixed argv that the model never supplies:

    python3 -I -B dispatch.py --root WORKSPACE [--manifest MANIFEST]

stdin carries one request {"version": 1, "name": NAME, "args": {...}}. stdout gets one result
{"version": 1, "ok": bool, "output": str, "error": str|null, "truncated": bool, "exit_code": int|null}. The
serialized result is never longer than RESULT_CAP chars. The exit status is 0 whenever a result was written.

Tools: read_file, list_files, search_files, edit_file, write_file, run_command, run_tests. Each one works only inside
the workspace root. Every path is relative, and its realpath must stay under the root. Writes under .git/ are
refused. Every output is capped, and a cap that cuts output says so in the text with the byte or line counts.
ok=false means the tool could not do what was asked (bad args, denied path, missing file, timeout). For
run_command and run_tests, a command that ran to the end is ok=true with its exit_code, which may be nonzero.

Path checks prevent honest mistakes. The laptop container is the execution
boundary; arbitrary commands retain its filesystem grants and network. Stdlib only.
"""
import argparse
import fnmatch
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading

SAME_PROCESS_GROUP = False

VERSION = 1
REQUEST_CAP = 200_000      # bytes of the request on stdin
ARGS_CAP = 24_000          # chars of json.dumps(args); the loop can count a call's arguments against this
RESULT_CAP = 24_000        # chars of the serialized result
OUTPUT_CAP = 20_000        # chars of a tool's output text
READ_MAX_LINES = 2000      # lines per read_file call
LINE_CAP = 2000            # chars kept of one line (read_file)
FILE_MAX_BYTES = 2_000_000  # files larger than this are not read, searched or edited
LIST_MAX = 500             # entries per list_files call
LIST_DEPTH_MAX = 3
SEARCH_MAX_HITS = 200
SEARCH_LINE_CAP = 300      # chars kept of one matching line
SEARCH_MAX_FILES = 5000    # files examined per search
PATTERN_CAP = 500
WRITE_MAX_CHARS = 20_000   # content of one write_file; larger files are built with edit_file
EDIT_MAX_CHARS = 10_000    # old and new of one edit_file, each
ARGV_MAX_ITEMS = 64
ARG_CAP = 4000             # chars of one argv item
TIMEOUT_DEFAULT_S = 60
TIMEOUT_MAX_S = 300
SELECT_MAX = 20            # run_tests selectors
SELECT_CAP = 200
STREAM_KEEP = OUTPUT_CAP // 2  # bytes of one stream kept, split between its head and tail
SKIP_DIRS = {'.git'}
MIN_OUTPUT = 500           # smallest per-call output limit the loop may set
_out_limit = OUTPUT_CAP    # this call's output limit: OUTPUT_CAP, or lower if the request sets max_output_chars


class ToolError(Exception):
    """A refusal or failure reported to the model as data: ok=false with this message."""


def result(ok, output='', error=None, truncated=False, exit_code=None):
    return {'version': VERSION, 'ok': ok, 'output': output, 'error': error, 'truncated': truncated,
            'exit_code': exit_code}


def fit(res):
    """Shrink output, then error, until the serialized result is at most RESULT_CAP chars."""
    for key in ('output', 'error'):
        while len(json.dumps(res)) > RESULT_CAP and res[key]:
            excess = len(json.dumps(res)) - RESULT_CAP
            keep = max(0, len(res[key]) - excess - 80)
            res[key] = res[key][:keep] + f'\n[truncated to fit the result cap: {keep} of {len(res[key])} chars]'
            res['truncated'] = True
            if keep == 0:
                res[key] = '[truncated to fit the result cap]'
                break
    return res


def cap_text(text, cap=None, what='chars'):
    """(text, truncated): text cut to cap chars (default: this call's output limit) with a marker that gives the
    counts."""
    cap = _out_limit if cap is None else cap
    if len(text) <= cap:
        return text, False
    marker = f'\n[truncated: showing {{}} of {len(text)} {what}]'
    keep = cap - len(marker) - 8
    return text[:keep] + marker.format(keep), True


# ---- arguments ----

def check_args(args, required, optional):
    if not isinstance(args, dict):
        raise ToolError('args must be an object')
    unknown = sorted(set(args) - set(required) - set(optional))
    if unknown:
        raise ToolError('unknown argument(s): ' + ', '.join(unknown)[:200])
    missing = [k for k in required if k not in args]
    if missing:
        raise ToolError('missing argument(s): ' + ', '.join(missing))
    for k, kind in {**required, **optional}.items():
        if k in args and args[k] is not None:
            ok = isinstance(args[k], kind) and not (kind is int and isinstance(args[k], bool))
            if not ok:
                raise ToolError(f'{k} must be {TYPE_NAMES[kind]}')


TYPE_NAMES = {str: 'a string', int: 'an integer', bool: 'true or false', list: 'an array'}


def int_arg(args, key, default, lo, hi):
    v = args.get(key)
    if v is None:
        return default
    if not lo <= v <= hi:
        raise ToolError(f'{key} must be between {lo} and {hi}')
    return v


# ---- paths ----

def resolve(root, rel, write=False):
    """Absolute real path of workspace-relative `rel`, or ToolError. The path need not exist."""
    if not isinstance(rel, str) or not rel or '\x00' in rel or len(rel) > 1000:
        raise ToolError('path must be a non-empty relative path')
    if os.path.isabs(rel):
        raise ToolError(f'path {rel!r} is absolute; use a path relative to the workspace')
    if '..' in rel.replace('\\', '/').split('/'):
        raise ToolError(f'path {rel!r} contains ..; paths must stay inside the workspace')
    full = os.path.realpath(os.path.join(root, rel))
    if full != root and not full.startswith(root + os.sep):
        raise ToolError(f'path {rel!r} resolves outside the workspace (symlink)')
    if write:
        inside = os.path.relpath(full, root).split(os.sep)
        if full == root or inside[0] in SKIP_DIRS:
            raise ToolError(f'writing {rel!r} is not allowed')
    return full


def show(root, full):
    return '.' if full == root else os.path.relpath(full, root)


def read_bytes(full, rel):
    if not os.path.exists(full):
        raise ToolError(f'{rel}: no such file')
    if os.path.isdir(full):
        raise ToolError(f'{rel}: is a directory')
    size = os.path.getsize(full)
    if size > FILE_MAX_BYTES:
        raise ToolError(f'{rel}: {size} bytes is over the {FILE_MAX_BYTES}-byte file limit')
    with open(full, 'rb') as f:
        return f.read(FILE_MAX_BYTES + 1)


def is_binary(data):
    return b'\x00' in data[:8192]


def decode_text(data, rel):
    if is_binary(data):
        raise ToolError(f'{rel}: binary file')
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError as e:
        raise ToolError(f'{rel}: not UTF-8 text ({e.reason} at byte {e.start})')


def atomic_write(full, text, mode=None):
    """Write text to full through a temp file in the same directory and a rename."""
    d = os.path.dirname(full)
    fd, tmp = tempfile.mkstemp(prefix='.tool-', suffix='.tmp', dir=d)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as f:
            f.write(text)
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, full)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---- tools ----

def read_file(root, args, manifest):
    check_args(args, {'path': str}, {'offset': int, 'limit': int})
    full = resolve(root, args['path'])
    text = decode_text(read_bytes(full, args['path']), args['path'])
    lines = text.splitlines()
    offset = int_arg(args, 'offset', 1, 1, max(1, len(lines)))
    limit = int_arg(args, 'limit', READ_MAX_LINES, 1, READ_MAX_LINES)
    out, used, cut_line = [], 0, False
    for n in range(offset, min(len(lines), offset - 1 + limit) + 1):
        line = lines[n - 1]
        if len(line) > LINE_CAP:
            line, cut_line = line[:LINE_CAP] + f' [line cut: {len(lines[n - 1])} chars]', True
        row = f'{n:6d}\t{line}'
        if used + len(row) + 1 > _out_limit - 200:
            break
        out.append(row)
        used += len(row) + 1
    last = offset - 1 + len(out)
    truncated = cut_line or last < len(lines)
    body = '\n'.join(out)
    if not lines:
        body = '[empty file]'
    elif last < len(lines):
        body += f'\n[showing lines {offset}-{last} of {len(lines)}; continue with offset={last + 1}]'
    return result(True, body, truncated=truncated)


def list_files(root, args, manifest):
    check_args(args, {}, {'path': str, 'depth': int})
    base = resolve(root, args.get('path') or '.')
    if not os.path.isdir(base):
        raise ToolError(f'{args.get("path")}: not a directory')
    depth = int_arg(args, 'depth', 2, 1, LIST_DEPTH_MAX)
    entries, total = [], 0

    def walk(d, level):
        nonlocal total
        try:
            names = sorted(os.listdir(d))
        except OSError as e:
            entries.append(f'{show(root, d)}/ [unreadable: {e.strerror}]')
            return
        for name in names:
            p = os.path.join(d, name)
            is_link, is_dir = os.path.islink(p), os.path.isdir(p)
            total += 1
            if len(entries) < LIST_MAX:
                suffix = '@' if is_link else '/' if is_dir else ''
                entries.append(show(root, p) + suffix)
            if is_dir and not is_link and name not in SKIP_DIRS and level < depth:
                walk(p, level + 1)

    walk(base, 1)
    body = '\n'.join(entries) or '[empty directory]'
    if total > LIST_MAX:
        body += f'\n[truncated: showing {LIST_MAX} of {total} entries]'
    body, cut = cap_text(body)
    return result(True, body, truncated=cut or total > LIST_MAX)


def search_files(root, args, manifest):
    check_args(args, {'pattern': str}, {'path': str, 'fixed': bool, 'glob': str})
    pattern = args['pattern']
    if not pattern or len(pattern) > PATTERN_CAP:
        raise ToolError(f'pattern must be 1 to {PATTERN_CAP} chars')
    try:
        rx = re.compile(re.escape(pattern) if args.get('fixed') else pattern)
    except re.error as e:
        raise ToolError(f'bad regular expression: {e}')
    glob = args.get('glob')
    base = resolve(root, args.get('path') or '.')
    if not os.path.exists(base):
        raise ToolError(f'{args.get("path")}: no such file or directory')
    if os.path.isfile(base):
        files = [base]
    else:
        files = []
        for d, dirs, names in os.walk(base):  # does not follow symlinked directories
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
            files.extend(os.path.join(d, n) for n in sorted(names))
    hits, total, skipped, examined = [], 0, 0, 0
    for p in files:
        rel = show(root, p)
        if glob and not (fnmatch.fnmatch(rel, glob) or fnmatch.fnmatch(os.path.basename(p), glob)):
            continue
        if os.path.islink(p) and not os.path.realpath(p).startswith(root + os.sep):
            skipped += 1
            continue
        if examined >= SEARCH_MAX_FILES:
            skipped += 1
            continue
        examined += 1
        try:
            if os.path.getsize(p) > FILE_MAX_BYTES:
                skipped += 1
                continue
            with open(p, 'rb') as f:
                data = f.read()
        except OSError:
            skipped += 1
            continue
        if is_binary(data):
            continue
        for n, line in enumerate(data.decode('utf-8', 'replace').splitlines(), 1):
            if rx.search(line):
                total += 1
                if len(hits) < SEARCH_MAX_HITS:
                    hits.append(f'{rel}:{n}:{line[:SEARCH_LINE_CAP]}')
    body = '\n'.join(hits) or '[no matches]'
    notes = []
    if total > len(hits):
        notes.append(f'showing {len(hits)} of {total} matches')
    if skipped:
        notes.append(f'{skipped} file(s) skipped (too large, unreadable, outside or over the {SEARCH_MAX_FILES}-file limit)')
    if notes:
        body += '\n[' + '; '.join(notes) + ']'
    body, cut = cap_text(body)
    return result(True, body, truncated=cut or total > len(hits))


def edit_file(root, args, manifest):
    check_args(args, {'path': str, 'old': str, 'new': str}, {'count': int})
    old, new = args['old'], args['new']
    if not old:
        raise ToolError('old must not be empty; use write_file to create a file')
    if len(old) > EDIT_MAX_CHARS or len(new) > EDIT_MAX_CHARS:
        raise ToolError(f'old and new are limited to {EDIT_MAX_CHARS} chars each')
    if old == new:
        raise ToolError('old and new are the same')
    count = int_arg(args, 'count', 1, 1, 1000)
    rel = args['path']
    full = resolve(root, rel, write=True)
    before = os.stat(full) if os.path.exists(full) else None
    text = decode_text(read_bytes(full, rel), rel)
    found = text.count(old)
    if found != count:
        raise ToolError(f'{rel}: old text found {found} time(s), expected {count}; '
                        'include more surrounding lines to make it unique, or set count')
    updated = text.replace(old, new)
    now = os.stat(full)
    if (now.st_mtime_ns, now.st_size, now.st_ino) != (before.st_mtime_ns, before.st_size, before.st_ino):
        raise ToolError(f'{rel}: changed while being edited; read it again')
    atomic_write(full, updated, mode=now.st_mode & 0o7777)
    delta = updated.count('\n') - text.count('\n')
    return result(True, f'edited {rel}: {count} replacement(s), {delta:+d} line(s), now {len(updated.encode())} bytes')


def write_file(root, args, manifest):
    check_args(args, {'path': str, 'content': str}, {})
    content, rel = args['content'], args['path']
    if len(content) > WRITE_MAX_CHARS:
        raise ToolError(f'content is {len(content)} chars, over the {WRITE_MAX_CHARS}-char limit; '
                        'write a smaller file and extend it with edit_file')
    full = resolve(root, rel, write=True)
    if os.path.isdir(full):
        raise ToolError(f'{rel}: is a directory')
    parent = os.path.dirname(full)
    if os.path.exists(parent) and not os.path.isdir(parent):
        raise ToolError(f'{rel}: a parent is not a directory')
    os.makedirs(parent, exist_ok=True)
    existed = os.path.exists(full)
    mode = os.stat(full).st_mode & 0o7777 if existed else 0o644
    atomic_write(full, content, mode=mode)
    return result(True, f'{"replaced" if existed else "created"} {rel} ({len(content.encode())} bytes)')


class Tail:
    """Reads one stream to the end, keeping its first and last bytes and the total count."""

    def __init__(self, stream, keep):
        self.head, self.tail, self.total, self.keep = bytearray(), bytearray(), 0, keep
        self.thread = threading.Thread(target=self._run, args=(stream,), daemon=True)
        self.thread.start()

    def _run(self, stream):
        half = self.keep // 2
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            self.total += len(chunk)
            room = half - len(self.head)
            if room > 0:
                self.head += chunk[:room]
                chunk = chunk[room:]
            if chunk:
                self.tail = (self.tail + chunk)[-(self.keep - half):]

    def text(self):
        kept = len(self.head) + len(self.tail)
        head = self.head.decode('utf-8', 'replace')
        if self.total == kept:
            return head + self.tail.decode('utf-8', 'replace'), False
        return (head + f'\n[... {self.total - kept} of {self.total} bytes omitted ...]\n'
                + self.tail.decode('utf-8', 'replace')), True


def run_argv(root, argv, timeout_s):
    """Run argv (no shell) with the workspace as cwd. Kills its process group on timeout and at the end."""
    try:
        proc = subprocess.Popen(argv, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=not SAME_PROCESS_GROUP)
    except OSError as e:
        raise ToolError(f'could not start {argv[0]!r}: {e.strerror or e}')
    keep = min(STREAM_KEEP, _out_limit // 2 - 100)
    out, err = Tail(proc.stdout, keep), Tail(proc.stderr, keep)
    timed_out = False
    try:
        proc.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
    finally:
        try:
            if SAME_PROCESS_GROUP:
                proc.kill()
            else:
                os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        proc.wait()
    for t, stream in ((out, proc.stdout), (err, proc.stderr)):
        t.thread.join(timeout=2)
        if not t.thread.is_alive():
            stream.close()
    so, so_cut = out.text()
    se, se_cut = err.text()
    body = (f'exit_code: {"timeout" if timed_out else proc.returncode}\n'
            f'--- stdout ({out.total} bytes) ---\n{so}\n--- stderr ({err.total} bytes) ---\n{se}')
    body, cut = cap_text(body)
    if timed_out:
        return result(False, body, error=f'timed out after {timeout_s} s; the process group was killed',
                      truncated=cut or so_cut or se_cut)
    return result(True, body, truncated=cut or so_cut or se_cut, exit_code=proc.returncode)


def check_argv(argv):
    if not argv or len(argv) > ARGV_MAX_ITEMS:
        raise ToolError(f'argv must be an array of 1 to {ARGV_MAX_ITEMS} strings')
    for a in argv:
        if not isinstance(a, str) or '\x00' in a or len(a) > ARG_CAP:
            raise ToolError(f'each argv item must be a string of at most {ARG_CAP} chars without NUL')
    if not argv[0]:
        raise ToolError('argv[0] must not be empty')


def run_command(root, args, manifest):
    check_args(args, {'argv': list}, {'timeout_s': int})
    check_argv(args['argv'])
    return run_argv(root, args['argv'], int_arg(args, 'timeout_s', TIMEOUT_DEFAULT_S, 1, TIMEOUT_MAX_S))


def run_tests(root, args, manifest):
    check_args(args, {}, {'select': list})
    if not manifest or not manifest.get('test_argv'):
        raise ToolError('this task has no test command')
    select = args.get('select') or []
    if len(select) > SELECT_MAX:
        raise ToolError(f'at most {SELECT_MAX} selectors')
    for s in select:
        if not isinstance(s, str) or not s or s.startswith('-') or '\x00' in s or len(s) > SELECT_CAP:
            raise ToolError(f'each selector must be a test path or id of at most {SELECT_CAP} chars, not an option')
    argv = list(manifest['test_argv']) + select
    check_argv(argv)
    return run_argv(root, argv, min(int(manifest.get('test_timeout_s', TIMEOUT_DEFAULT_S)), TIMEOUT_MAX_S))


TOOLS = {f.__name__: f for f in (read_file, list_files, search_files, edit_file, write_file, run_command, run_tests)}

# Function specs for the model, in the chat-completions tools format. The loop offers these; the dispatcher checks
# every argument again, so the specs are a hint to the model, not the contract.
_S, _I, _B = {'type': 'string'}, {'type': 'integer'}, {'type': 'boolean'}


def _spec(name, description, props, required):
    return {'type': 'function', 'function': {'name': name, 'description': description, 'parameters': {
        'type': 'object', 'properties': props, 'required': required, 'additionalProperties': False}}}


TOOL_SPECS = [
    _spec('read_file', f'Read a text file in the workspace as numbered lines (at most {READ_MAX_LINES} lines).',
          {'path': _S, 'offset': {**_I, 'description': 'first line, from 1'}, 'limit': _I}, ['path']),
    _spec('list_files', f'List files under a workspace directory (depth 1 to {LIST_DEPTH_MAX}, default 2).',
          {'path': _S, 'depth': _I}, []),
    _spec('search_files', 'Search text files for a regular expression (fixed=true for a literal string); '
          'results are path:line:text.', {'pattern': _S, 'path': _S, 'fixed': _B,
                                         'glob': {**_S, 'description': 'e.g. *.py'}}, ['pattern']),
    _spec('edit_file', 'Replace exact text in a file. old must occur exactly count times (default 1).',
          {'path': _S, 'old': _S, 'new': _S, 'count': _I}, ['path', 'old', 'new']),
    _spec('write_file', f'Create or replace a file with content (at most {WRITE_MAX_CHARS} chars).',
          {'path': _S, 'content': _S}, ['path', 'content']),
    _spec('run_command', 'Run a command in the workspace without a shell; argv is the program and its arguments. '
          'Uses the laptop execution permissions.', {'argv': {'type': 'array', 'items': _S},
                          'timeout_s': {**_I, 'description': f'1 to {TIMEOUT_MAX_S}, default {TIMEOUT_DEFAULT_S}'}},
          ['argv']),
    _spec('run_tests', "Run the task's test command; select optionally names test files or ids to run.",
          {'select': {'type': 'array', 'items': _S}}, []),
]


def dispatch(root, request, manifest=None):
    """One request dict -> one result dict that fits RESULT_CAP. Never raises for a bad request.

    The request may carry max_output_chars (MIN_OUTPUT to OUTPUT_CAP) beside name and args. The trusted loop sets
    it from the task's remaining output budget; it is not a model argument. Output never exceeds it."""
    global _out_limit
    _out_limit = OUTPUT_CAP
    try:
        if not isinstance(request, dict) or request.get('version') != VERSION:
            raise ToolError(f'request must be an object with version {VERSION}')
        unknown = sorted(set(request) - {'version', 'name', 'args', 'max_output_chars'})
        if unknown:
            raise ToolError('unknown request field(s): ' + ', '.join(map(str, unknown))[:200])
        limit = request.get('max_output_chars', OUTPUT_CAP)
        if not isinstance(limit, int) or isinstance(limit, bool) or not MIN_OUTPUT <= limit <= OUTPUT_CAP:
            raise ToolError(f'max_output_chars must be an integer from {MIN_OUTPUT} to {OUTPUT_CAP}')
        _out_limit = limit
        name, args = request.get('name'), request.get('args', {})
        if name not in TOOLS:
            raise ToolError(f'unknown tool {str(name)[:64]!r}; tools are ' + ', '.join(TOOLS))
        if len(json.dumps(args)) > ARGS_CAP:
            raise ToolError(f'arguments are over the {ARGS_CAP}-char limit')
        res = TOOLS[name](root, args, manifest)
    except ToolError as e:
        res = result(False, error=str(e))
    except Exception as e:  # a dispatcher bug or an OS error: report it, never a traceback with paths
        res = result(False, error=f'{type(e).__name__}: {str(e)[:300]}')
    if len(res['output']) > _out_limit:
        res['output'], _ = cap_text(res['output'])
        res['truncated'] = True
    return fit(res)


def main(argv=None, stdin=None, stdout=None):
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout
    ap = argparse.ArgumentParser(description='Coding tool dispatcher: one JSON request on stdin.')
    ap.add_argument('--root', required=True)
    ap.add_argument('--manifest')
    a = ap.parse_args(argv)
    root = os.path.realpath(a.root)
    manifest = None
    raw = stdin.read(REQUEST_CAP + 1)
    if not os.path.isdir(root):
        res = result(False, error='workspace root is missing')
    elif len(raw) > REQUEST_CAP:
        res = result(False, error=f'request is over {REQUEST_CAP} bytes')
    else:
        try:
            if a.manifest:
                with open(a.manifest, encoding='utf-8') as f:
                    manifest = json.load(f)
            request = json.loads(raw.decode('utf-8'))
        except (OSError, ValueError) as e:
            res = result(False, error=f'bad request or manifest: {type(e).__name__}')
        else:
            res = dispatch(root, request, manifest)
    stdout.write(json.dumps(res, ensure_ascii=False) + '\n')
    stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
