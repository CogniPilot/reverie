"""Bounded local transport for the accepted ledger; no authority or effect adapter.

Installed caller supplies the private ledger path, never request-controlled paths.
One operation per child; no live entrypoint imports this transport.
"""
import json
from pathlib import Path
import sys

# Pin the sibling packaged source, independent of PYTHONPATH/user/site packages.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reverie.resume_ledger import Binding, LedgerError, ResumeLedger


def execute(ledger, command):
    if type(command) is not dict or type(command.get('op')) is not str:
        raise LedgerError('INPUT_INVALID')
    op = command['op']
    fields = {'restart': {'op', 'now'}, 'reserve': {'op', 'binding', 'key', 'now'},
              'advance': {'op', 'binding', 'attempt', 'sequence', 'expected', 'state', 'reason', 'key', 'now'}}
    if op not in fields or set(command) != fields[op]:
        raise LedgerError('INPUT_INVALID')
    if op == 'restart':
        return ledger.reconcile_restart(command['now'])
    value = command['binding']
    if type(value) is not dict or set(value) != set(Binding.__dataclass_fields__):
        raise LedgerError('INPUT_INVALID')
    binding = Binding(**value)
    if op == 'reserve':
        return ledger.reserve(binding, command['key'], command['now'])
    return ledger.advance(binding, command['attempt'], command['sequence'], command['expected'],
                          command['state'], command['reason'], command['key'], command['now'])


def main():
    ledger = None
    try:
        if len(sys.argv) != 2:
            raise LedgerError('INPUT_INVALID')
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise LedgerError('INPUT_INVALID')
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise LedgerError('INPUT_INVALID')
                result[key] = value
            return result
        command = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(LedgerError('INPUT_INVALID')))
        ledger = ResumeLedger(sys.argv[1])
        output = {'ok': True, 'result': execute(ledger, command)}
    except Exception:
        # Never expose paths, exceptions, SQL or rejected input; caller fails closed.
        output = {'ok': False, 'code': 'LEDGER_UNAVAILABLE'}
    finally:
        if ledger is not None:
            ledger.close()
    encoded = json.dumps(output, separators=(',', ':'), allow_nan=False).encode('ascii')
    if len(encoded) > 262144:
        encoded = b'{"ok":false,"code":"LEDGER_UNAVAILABLE"}'
    sys.stdout.buffer.write(encoded)


if __name__ == '__main__':
    main()
