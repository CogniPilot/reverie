import json
import math


INTEGER_FIELDS = frozenset(('wall_ms', 'peak_rss_bytes', 'rss_samples', 'max_members',
    'disk_samples', 'workspace_bytes', 'workspace_entries', 'min_free_bytes_seen'))
INTERVAL_FIELDS = frozenset(('rss_interval_s', 'disk_interval_s'))
REASONS = frozenset(('done', 'timeout', 'refused', 'watch', 'rss', 'free', 'workspace'))


def runner_report(raw):
    try:
        if not isinstance(raw, (bytes, bytearray)) or len(raw) > 4096:
            return None
        lines = raw.decode('utf-8').splitlines()
        if not lines:
            return None
        envelope = json.loads(lines[-1])
        if not isinstance(envelope, dict) or set(envelope) != {'sandbox_runner'}:
            return None
        report = envelope['sandbox_runner']
        if (not isinstance(report, dict) or not {'rc', 'mode', 'reason'} <= set(report) or
                set(report) - ({'rc', 'mode', 'reason'} | INTEGER_FIELDS | INTERVAL_FIELDS) or
                type(report['rc']) is not int or not 0 <= report['rc'] <= 255 or
                report['mode'] != 'task' or not isinstance(report['reason'], str) or
                report['reason'] not in REASONS):
            return None
        for key in INTEGER_FIELDS & report.keys():
            value = report[key]
            if key == 'min_free_bytes_seen' and value is None:
                continue
            if type(value) is not int or not 0 <= value <= 2 ** 63 - 1:
                return None
        for key in INTERVAL_FIELDS & report.keys():
            value = report[key]
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= 86400:
                return None
        return report
    except (ValueError, TypeError, UnicodeError):
        return None
