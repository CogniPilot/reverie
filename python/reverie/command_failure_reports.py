"""Closed metadata projection for the protected broker's failure report reader.

This module neither authenticates a browser nor grants producer authority. The
host broker supplies the collector; the owner API must independently authorize
and recheck its caller. No submitted command text or diagnostic is published.
"""
import json

from .hands.command_catalog import CATALOG
from .worker_storage import require_uuid

MAX_EMPLOYEES = 64
MAX_GROUPS = 2048
VISIBLE_GROUPS = 20
MAX_RESPONSE_BYTES = 262144
MAX_COUNT = 2 ** 31 - 1
PROVENANCE = 'SELF_REPORTED_RESULT'
HARNESS_SUPPORT = {'hands': 'self_reported', 'claude': 'unavailable', 'codex': 'unavailable'}


def _need(value):
    if not value:
        raise ValueError('TELEMETRY_REPORT_REFUSED')


def _closed(value, fields):
    _need(type(value) is dict and set(value) == set(fields))


def _integer(value, maximum=MAX_COUNT):
    _need(type(value) is int and 0 <= value <= maximum)
    return value


def selected_employees(value):
    _need(type(value) is list and len(value) <= MAX_EMPLOYEES)
    _need(all(type(item) is str for item in value))
    _need(len(set(value)) == len(value))
    for item in value:
        require_uuid(item)
    return tuple(value)


def report_request(raw):
    """Decode a small closed read-only request; no producer/config action exists."""
    _need(type(raw) is bytes and len(raw) <= 4096)
    def pairs(items):
        result = {}
        for key, value in items:
            _need(key not in result)
            result[key] = value
        return result
    def number(text):
        _need(text == '1')
        return 1
    def invalid(_):
        raise ValueError('TELEMETRY_REPORT_REFUSED')
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_int=number,
                           parse_float=invalid, parse_constant=invalid)
        _closed(value, ('v', 'action', 'employee_ids'))
        _need(type(value['v']) is int and value['v'] == 1)
        _need(value['action'] == 'command-failures')
        return selected_employees(value['employee_ids'])
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ValueError('TELEMETRY_REPORT_REFUSED') from None


def _counts(value, employee_id, keys):
    _closed(value, ('v', 'employee_id', 'harness', 'counts', 'evicted', 'expired', 'dropped', 'provenance'))
    _need(type(value['v']) is int and value['v'] == 1)
    _need(value['employee_id'] == employee_id and value['harness'] == 'hands')
    _need(value['provenance'] == PROVENANCE)
    _need(type(value['counts']) is list and len(value['counts']) <= MAX_GROUPS)
    result, seen = [], set()
    for row in value['counts']:
        _closed(row, ('tool', 'category', 'exit', 'count'))
        _need(type(row['tool']) is str and row['tool'] in keys)
        code = row['exit']
        _need(type(code) is int and -255 <= code <= 255 and code != 0)
        category = 'COMMAND_NOT_FOUND' if code == 127 else 'SIGNAL' if code < 0 else 'NONZERO'
        _need(row['category'] == category)
        _need(1 <= _integer(row['count'], MAX_GROUPS) <= MAX_GROUPS)
        identity = row['tool'], category, code
        _need(identity not in seen)
        seen.add(identity)
        result.append({'tool': row['tool'], 'category': category, 'exit': code, 'count': row['count']})
    _need(sum(row['count'] for row in result) <= MAX_GROUPS)
    counters = {key: _integer(value[key]) for key in ('evicted', 'expired', 'dropped')}
    return result, counters


def build_report(collector, employees):
    """Project fixed bounded counts, including explicit unavailable producers.

    Report groups are learning metadata, not proof of a command or an effect.
    An unreadable/malformed employee report is unavailable, never an empty success.
    """
    selected = selected_employees(list(employees) if type(employees) is tuple else employees)
    _need(type(collector.enabled) is bool)
    keys = frozenset(collector.keys) | {'UNKNOWN_COMMAND'}
    _need(keys <= frozenset(CATALOG) | {'UNKNOWN_COMMAND'})
    rows, totals = [], {}
    for employee in selected:
        status, counts, counters = 'disabled', [], dict(evicted=0, expired=0, dropped=0)
        if collector.enabled:
            try:
                observed = collector.report_employee(employee)
                _closed(observed, ('status', 'report'))
                _need(observed['status'] in ('ready', 'no_data', 'unavailable'))
                status = observed['status']
                if status == 'ready':
                    counts, counters = _counts(observed['report'], employee, keys)
                else:
                    _need(observed['report'] is None)
            except Exception:
                status, counts = 'unavailable', []
                counters = dict(evicted=0, expired=0, dropped=0)
        for row in counts:
            key = row['tool'], row['category'], row['exit']
            count, owners = totals.get(key, (0, 0))
            totals[key] = (count + row['count'], owners + 1)
        counts.sort(key=lambda row: (-row['count'], row['tool'], row['category'], row['exit']))
        rows.append({'employee_id': employee, 'harness': 'hands', 'status': status,
                     'counts': counts[:VISIBLE_GROUPS], 'truncated': len(counts) > VISIBLE_GROUPS,
                     **counters})
    top = [{'tool': tool, 'category': category, 'exit': code, 'count': count, 'employee_count': owners}
           for (tool, category, code), (count, owners) in totals.items()]
    top.sort(key=lambda row: (-row['count'], row['tool'], row['category'], row['exit']))
    value = {'v': 1, 'enabled': collector.enabled, 'provenance': PROVENANCE,
             'harness_support': dict(HARNESS_SUPPORT), 'employees': rows,
             'top_repeats': top[:VISIBLE_GROUPS], 'truncated': len(top) > VISIBLE_GROUPS}
    _need(len(json.dumps(value, separators=(',', ':')).encode()) <= MAX_RESPONSE_BYTES)
    return value


def decode_report(raw, employees):
    """Refuse unexpected fields before the private client publishes any bytes."""
    _need(type(raw) is bytes and len(raw) <= MAX_RESPONSE_BYTES)
    def pairs(items):
        result = {}
        for key, value in items:
            _need(key not in result)
            result[key] = value
        return result
    def integer(text):
        _need(len(text) <= 10 and text.isascii())
        unsigned = text[1:] if text.startswith('-') else text
        _need(unsigned.isdecimal())
        value = int(text)
        _need(-255 <= value <= MAX_COUNT)
        return value
    def invalid(_):
        raise ValueError('TELEMETRY_REPORT_REFUSED')
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_int=integer,
                           parse_float=invalid, parse_constant=invalid)
        _closed(value, ('v', 'enabled', 'provenance', 'harness_support', 'employees', 'top_repeats', 'truncated'))
        _need(type(value['v']) is int and value['v'] == 1 and type(value['enabled']) is bool)
        _need(value['provenance'] == PROVENANCE and value['harness_support'] == HARNESS_SUPPORT)
        _need(type(value['truncated']) is bool and type(value['employees']) is list)
        expected = selected_employees(list(employees) if type(employees) is tuple else employees)
        _need(len(value['employees']) == len(expected))
        for employee, row in zip(expected, value['employees']):
            _closed(row, ('employee_id', 'harness', 'status', 'counts', 'truncated', 'evicted', 'expired', 'dropped'))
            _need(row['employee_id'] == employee and row['harness'] == 'hands')
            _need(row['status'] in (('ready', 'no_data', 'unavailable') if value['enabled'] else ('disabled',)))
            _need(type(row['truncated']) is bool and type(row['counts']) is list and len(row['counts']) <= VISIBLE_GROUPS)
            _counts({'v': 1, 'employee_id': employee, 'harness': 'hands', 'counts': row['counts'],
                     'evicted': row['evicted'], 'expired': row['expired'], 'dropped': row['dropped'],
                     'provenance': PROVENANCE}, employee, frozenset(CATALOG) | {'UNKNOWN_COMMAND'})
            if row['status'] != 'ready':
                _need(not row['counts'] and not row['truncated'] and
                      all(row[key] == 0 for key in ('evicted', 'expired', 'dropped')))
        _need(type(value['top_repeats']) is list and len(value['top_repeats']) <= VISIBLE_GROUPS)
        seen = set()
        for row in value['top_repeats']:
            _closed(row, ('tool', 'category', 'exit', 'count', 'employee_count'))
            _need(type(row['tool']) is str and row['tool'] in (*CATALOG, 'UNKNOWN_COMMAND'))
            code = row['exit']
            _need(type(code) is int and -255 <= code <= 255 and code != 0)
            _need(row['category'] == ('COMMAND_NOT_FOUND' if code == 127 else 'SIGNAL' if code < 0 else 'NONZERO'))
            _need(1 <= _integer(row['count'], MAX_GROUPS * len(expected)))
            _need(1 <= _integer(row['employee_count'], len(expected)))
            identity = row['tool'], row['category'], code
            _need(identity not in seen)
            seen.add(identity)
        if not value['enabled']:
            _need(not value['top_repeats'] and not value['truncated'])
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ValueError('TELEMETRY_REPORT_REFUSED') from None
