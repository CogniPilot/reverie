"""Bounded, path-free projection of explicitly configured USER observations."""
import argparse
import datetime
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import resource
import stat
import sys
import time

spec = importlib.util.spec_from_file_location('_history_user', Path(__file__).resolve().with_name('collector_user.py'))
user = importlib.util.module_from_spec(spec); spec.loader.exec_module(user)
UUID = re.compile(r'GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z')
FILES = re.compile(r'(samples-\d{4}-\d{2}-\d{2}|rollup-hour-\d{4}-\d{2}|rollup-day-\d{4})\.jsonl\Z')
MAX_BYTES, MAX_ROWS, MAX_POINTS = 32 << 20, 100000, 1024


def number(value, low=0, high=100):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def statistics(value):
    if number(value): return {'min': value, 'avg': value, 'max': value, 'n': 1}
    if (isinstance(value, dict) and set(value) == {'min', 'avg', 'max', 'n'} and
        all(number(value[k]) for k in ('min', 'avg', 'max')) and
        value['min'] <= value['avg'] <= value['max'] and type(value['n']) is int and 1 <= value['n'] <= 1000000):
        return value
    return None


def combine(values):
    values = [v for v in values if v is not None]
    n = sum(v['n'] for v in values)
    return {'min': min(v['min'] for v in values), 'avg': round(sum(v['avg']*v['n'] for v in values)/n, 3),
            'max': max(v['max'] for v in values), 'n': n} if n else None


def file_interval(name):
    """UTC filename intervals, not mtimes or a caller-selected path."""
    if name.startswith('samples-'):
        date = datetime.date.fromisoformat(name[8:-6]); kind = 'raw'
        begin = datetime.datetime.combine(date, datetime.time(), datetime.timezone.utc)
        finish = begin + datetime.timedelta(days=1)
    elif name.startswith('rollup-hour-'):
        year, month = map(int, name[12:-6].split('-')); kind = 'hour'
        begin = datetime.datetime(year, month, 1, tzinfo=datetime.timezone.utc)
        finish = datetime.datetime(year+month//12, month % 12+1, 1, tzinfo=datetime.timezone.utc)
    else:
        year = int(name[11:-6]); kind = 'day'
        begin = datetime.datetime(year, 1, 1, tzinfo=datetime.timezone.utc)
        finish = datetime.datetime(year+1, 1, 1, tzinfo=datetime.timezone.utc)
    return kind, int(begin.timestamp()), int(finish.timestamp())


def freshness_tail(path):
    """A stable private tail, never an unbounded full-file freshness scan."""
    user.ancestry(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_mode & 0o077:
            raise ValueError('Freshness source custody refused')
        offset = max(0, before.st_size-262144); os.lseek(fd, offset, os.SEEK_SET)
        chunks = []; size = 0
        while size < min(before.st_size-offset, 262144):
            piece = os.read(fd, min(65536, before.st_size-offset-size))
            if not piece: break
            chunks.append(piece); size += len(piece)
        stamp = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if size != before.st_size-offset or stamp(before) != stamp(os.fstat(fd)) or stamp(before) != stamp(path.lstat()):
            raise ValueError('Freshness source changed')
        data = b''.join(chunks)
        # Discard the possible first partial record; never treat a tail fragment
        # as a complete scan or a malformed full record.
        return (data.split(b'\n', 1)[1] if b'\n' in data else b'') if offset else data, size, not offset
    finally: os.close(fd)


def query(path, start, end, resolution='auto', gpu=None, now=None):
    """No request path, free text, command, attribution or effect authority in output."""
    now = int(time.time()) if now is None else now
    if (type(start) is not int or type(end) is not int or not 0 <= start < end <= now + 5 or
        end-start > 400*86400 or resolution not in ('auto', 'minute', 'five-minute', 'hour', 'day') or
        (gpu is not None and (not isinstance(gpu, str) or not UUID.fullmatch(gpu)))):
        raise ValueError('History query refused')
    deadline = time.monotonic() + 5
    config_raw = user.private_bytes(path)
    cfg = user.configuration(path); root = user.state_directory(cfg); root_id = (root.stat().st_dev, root.stat().st_ino)
    choices = {'minute': 60, 'five-minute': 300, 'hour': 3600, 'day': 86400}
    step = next((s for s in (60, 300, 3600, 86400) if math.ceil((end-start)/s) <= MAX_POINTS), 86400) if resolution == 'auto' else choices[resolution]
    origin = start-start % step
    if math.ceil((end-origin)/step) > MAX_POINTS: raise ValueError('History point bound exceeded')
    entries = sorted(root.iterdir()); rows = []; malformed = 0; total = 0; count = 0; latest = None; interval = cfg['intervalSeconds']; devices = set()
    if len(entries) > 1024: raise ValueError('History file bound exceeded')
    selected = [(file, file_interval(file.name)) for file in entries if FILES.fullmatch(file.name)]
    covered = set(); scanned_raw = {}; seen_periods = set()

    def records(file, window, data, charged=None):
        nonlocal total, count, malformed
        if time.monotonic() >= deadline: raise ValueError('History read deadline exceeded')
        total += len(data) if charged is None else charged
        if total > MAX_BYTES: raise ValueError('History byte bound exceeded')
        for line in data.splitlines():
            count += 1
            if count % 1000 == 0 and time.monotonic() >= deadline: raise ValueError('History read deadline exceeded')
            if count > MAX_ROWS or len(line) > 262144: raise ValueError('History row bound exceeded')
            try: row = json.loads(line, object_pairs_hook=user.unique)
            except (ValueError, UnicodeError, RecursionError): malformed += 1; continue
            if not isinstance(row, dict): malformed += 1; continue
            t = row.get('t') if window[0] == 'raw' else row.get('start')
            if type(t) is not int or not 0 <= t or not window[1] <= t < window[2] or t > now+5:
                malformed += 1; continue
            yield t, row

    kind = 'day' if step == 86400 else 'hour' if step == 3600 else None
    # Prefer one committed matching period wholly inside the requested range.
    # Closed period != complete sampling: the recorded count/gaps remain intact.
    for file, window in selected:
        if window[0] != kind or window[2] <= start or window[1] >= end: continue
        for t, row in records(file, window, user.private_bytes(file, 8 << 20)):
            if row.get('kind') != kind or row.get('end') != t+step or t % step or type(row.get('samples')) is not int or not 1 <= row['samples'] <= MAX_ROWS:
                malformed += 1; continue
            if not start <= t or t+step > min(end, now): continue
            if t in seen_periods: raise ValueError('Duplicate committed history period')
            seen_periods.add(t); rows.append((t, False, row))
            if gpu is None or (isinstance(row.get('gpu_devices'), list) and not row.get('gpu_devices_incomplete', False)):
                covered.add(t)
    for file, window in selected:
        if window[0] != 'raw' or window[2] <= start or window[1] >= end: continue
        if all(t in covered for t in range(max(origin, window[1]), min(end, window[2]), step)): continue
        newest = None
        for t, row in records(file, window, user.private_bytes(file, 8 << 20)):
            newest = t if newest is None else max(t, newest)
            if start <= t < end and t-t % step not in covered: rows.append((t, True, row))
        scanned_raw[file.name] = newest
    # Freshness is independent of the requested range. Open at most eight newest
    # date files and only their last256KiB unless the full file was already read.
    # A partial tail is explicitly not a global archive/completeness assertion.
    raw_files = sorted(((file, window) for file, window in selected if window[0] == 'raw' and window[1] <= now+5), reverse=True)
    freshness_complete = True
    for file, window in raw_files[:8]:
        if file.name in scanned_raw: newest = scanned_raw[file.name]
        else:
            tail, charged, complete = freshness_tail(file); freshness_complete = freshness_complete and complete
            newest = max((t for t, _ in records(file, window, tail, charged)), default=None)
        if newest is not None: latest = newest; break
    if latest is None and len(raw_files) > 8: freshness_complete = False
    buckets = {}
    for t, raw_sample, row in rows:
        bucket = t-t % step; buckets.setdefault(bucket, {'raw': [], 'rollup': []})['raw' if raw_sample else 'rollup'].append(row)
    points = []
    for t in range(origin, end, step):
        if time.monotonic() >= deadline: raise ValueError('History read deadline exceeded')
        groups = buckets.get(t, {}); samples = groups.get('raw') or groups.get('rollup') or []; raw_sample = bool(groups.get('raw'))
        values = {'cpu_pct': [], 'mem_pct': [], 'gpu_pct': []}; missing_identity = 0
        for row in samples:
            listed = (row.get('gpu') or {}).get('devices', []) if raw_sample and isinstance(row.get('gpu'), dict) else row.get('gpu_devices', [])
            for device in listed[:64] if isinstance(listed, list) else []:
                if (isinstance(device, dict) and isinstance(device.get('uuid'), str) and UUID.fullmatch(device['uuid']) and
                    (not raw_sample or device.get('identity_status') == 'available')): devices.add(device['uuid'])
            if len(devices) > 64: raise ValueError('History identity bound exceeded')
            for metric in ('cpu_pct', 'mem_pct'): values[metric].append(statistics(row.get(metric)))
            if gpu is None: values['gpu_pct'].append(statistics(row.get('gpu_pct')))
            else:
                listed = (row.get('gpu') or {}).get('devices', []) if raw_sample and isinstance(row.get('gpu'), dict) else row.get('gpu_devices', [])
                selected = [d for d in listed if isinstance(d, dict) and d.get('uuid') == gpu and (not raw_sample or d.get('identity_status') == 'available')] if isinstance(listed, list) else []
                if len(selected) == 1:
                    values['gpu_pct'].append(statistics(selected[0].get('util_pct')))
                    if not raw_sample:
                        absent = selected[0].get('missing_samples')
                        if type(absent) is not int or not 0 <= absent <= MAX_ROWS: missing_identity += 1
                        else: missing_identity += absent
                else:
                    n = row.get('samples')
                    missing_identity += n if not raw_sample and type(n) is int and 0 <= n <= MAX_ROWS else 1
        projected = {key: combine(value) for key, value in values.items()}
        observed = len(samples) if raw_sample else sum(r.get('samples', 0) for r in samples if type(r.get('samples')) is int and 0 <= r['samples'] <= MAX_ROWS)
        points.append({'t': t, 'end': min(end, t+step), **projected, 'samples': observed,
                       'status': 'missing' if not samples else 'partial' if any(v is None for v in projected.values()) or missing_identity or observed < max(1, step//interval) else 'observed',
                       'deviceIdentityMissing': missing_identity if gpu else None})
    # Recheck selected custody/config after all I/O; no stale path substitution.
    if (user.private_bytes(path) != config_raw or user.configuration(path) != cfg or user.state_directory(cfg) != root or
        (root.stat().st_dev, root.stat().st_ino) != root_id): raise ValueError('History source changed')
    return {'version': 1, 'scope': 'shared-host-unattributed-observations', 'sourceMode': 'user-observations', 'start': start, 'end': end,
            'bucketSeconds': step, 'gpuUUID': gpu, 'deviceUUIDs': sorted(devices), 'deviceUUIDsScope': 'queried-records', 'lastSampleAt': latest,
            'freshness': ('unavailable' if raw_files else 'missing') if latest is None else 'stale' if now-latest > max(2*interval, 60) else 'fresh',
            'freshnessSource': 'bounded-latest-raw-tail', 'freshnessReadComplete': freshness_complete,
            'intervalSeconds': interval, 'retentionDays': cfg['retentionDays'], 'rollupRetentionDays': cfg['rollupRetentionDays'],
            'malformedLines': malformed, 'malformedLinesScope': 'read-records', 'points': points, 'effectAuthority': False, 'employeeAttribution': None,
            'historicalDeviceCoverage': 'only-recorded-valid-UUIDs; legacy-rollups-have-no-device-history'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--config', required=True)
    parser.add_argument('--start', required=True, type=int); parser.add_argument('--end', required=True, type=int)
    parser.add_argument('--resolution', default='auto'); parser.add_argument('--gpu')
    args = parser.parse_args(argv)
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        cap = 256 << 20
        resource.setrlimit(resource.RLIMIT_AS, (min(cap, soft) if soft >= 0 else cap, hard))
        value = query(Path(args.config), args.start, args.end, args.resolution, args.gpu)
        output = json.dumps(value, allow_nan=False, separators=(',', ':')).encode()
        if len(output) > 2 << 20: raise ValueError('History output bound exceeded')
        sys.stdout.buffer.write(output+b'\n'); return 0
    except (OSError, ValueError, TypeError, MemoryError):
        print('Resource history unavailable', file=sys.stderr); return 2


if __name__ == '__main__':
    raise SystemExit(main())
