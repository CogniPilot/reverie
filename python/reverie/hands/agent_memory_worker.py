"""One bounded memory operation, launched by the harness in its own process group.

No service/owner credential is accepted here. Chat uses the harness's existing agent
CLI identity. The parent kills this entire process group when its deadline expires.
"""
import json
import sqlite3
import sys
from pathlib import Path

# -I excludes the script directory. Only the explicitly deployed sibling modules
# are imported; never a cwd, HOME or another instance's code.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from agent_loop import Chat, ChatNotFound
from reverie.instance import load_instance
from reverie.memory import MemoryStore
import agent_journal
import agent_journal_model


def checked_journal_recall(journal, chat, room, query, compact=False):
    """Same current-source checks for automatic and deliberate journal reads."""
    entries = []
    omitted = False
    model = agent_journal_model.ReadModel(journal, chat, room)
    projected = model.project(journal.recall(query), current_only=True)
    omitted = model.omitted
    for checked in projected:
        entry = checked['entry']
        if compact:
            item = {'entry_id': entry['id'], 'committed_ms': entry['committed_ms'],
                    'text': entry['draft']['text'], 'tags': entry['draft']['tags'],
                    'source_ids': [s['id'] for s in entry['draft']['sources']],
                    'provenance': entry['draft'].get('annotations', {}).get('provenance', 'unknown'),
                    'supersedes': entry['draft'].get('annotations', {}).get('supersedes', []),
                    'related': entry['draft'].get('annotations', {}).get('related', [])}
            candidate = {'status': 'available', 'scope': room, 'entries': entries + [item],
                         'omitted_or_source_changed': False}
            fits = len(agent_journal.encoded(candidate).encode()) <= agent_journal.CAPSULE_BYTES
        else:
            item = {'entry_id': entry['id'], 'committed_ms': entry['committed_ms'],
                    **entry['draft'], 'source_ids': [s['id'] for s in entry['draft']['sources']],
                    'provenance': entry['draft'].get('annotations', {}).get('provenance', 'unknown'),
                    'supersedes': entry['draft'].get('annotations', {}).get('supersedes', []),
                    'related': entry['draft'].get('annotations', {}).get('related', []),
                    'evidence': 'source revisions checked; interpretation not verified'}
            fits = len(agent_journal.encoded(entries + [item])) <= agent_journal.RESULT_CHARS - 200
        if not fits:
            omitted = True
            continue  # Keep complete entries; never truncate away a qualification.
        entries.append(item)
    return {'status': 'available', **({'scope': room} if compact else {}),
            'entries': entries, 'omitted_or_source_changed': omitted}


def source_refusal(chat, room, draft, captured, events):
    """Why the cited sources no longer verify for this save, or None when every one does."""
    selected = {s['id'] for s in draft['sources']} | {captured['end']['id']}
    for source_id in sorted(selected):
        try:
            actual = chat.exact_message(room, source_id)
        except ChatNotFound:  # the server says it is gone; a failed or timed-out read still raises
            return {'status': 'refused', 'reason': 'source_unavailable'}
        expected = captured['end'] if source_id == captured['end']['id'] else events[source_id]
        if agent_journal.revision(actual, room) != expected:
            return {'status': 'refused', 'reason': 'source_changed'}
        if any(s['quote'] not in actual['text'] for s in draft['sources'] if s['id'] == source_id):
            return {'status': 'refused', 'reason': 'quote_not_in_source'}
    return None


def require_room(chat, room):
    agent_journal.uuid(room)
    for listed in chat.member_rooms():
        if listed.get('id') != room:
            continue
        # Current ordinary rooms omit kind and identify their visibility and members.
        if ('kind' not in listed and not listed.get('dm') and
                listed.get('visibility') in ('public', 'private') and
                isinstance(listed.get('members'), list)):
            return
    raise PermissionError('current shared-room membership required; DMs excluded')


def open_journal(root, room):
    directory = root / room
    path = directory / 'memory.sqlite'
    if any(p.is_symlink() for p in (root, directory, path)):
        raise ValueError('room memory path may not be a symlink')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.mkdir(mode=0o700, exist_ok=True)
    memory = MemoryStore(path)
    path.chmod(0o600)
    memory.close()
    return agent_journal.Journal(path)


def perform(job, chat=None):
    cfg = job['config']
    if chat is None and job['op'] in ('journal_source', 'journal_receipt'):
        # Existing injected-chat tests exercise the legacy result as an oracle.
        raise ValueError('journal read belongs to the native worker')
    chat = chat or Chat(cfg['cli'], cfg['memory_timeout_s'])
    instance = Path(cfg['memory_instance'])
    if not instance.is_absolute():
        raise ValueError('select an absolute owner instance config')
    root = load_instance(instance).data_dir / 'harness-room-memory-v1'
    room = job['room']
    if job['op'].startswith('journal_'):
        if cfg.get('journal_enabled') is not True:
            raise ValueError('journal not enabled')
        if job['op'] == 'journal_source':
            # Read through the current actor's normal room transport, not a
            # journal import or a cross-room/filesystem lookup. No DB is opened.
            require_room(chat, room)
            source_id = agent_journal.uuid(job['message_id'])
            end = job['captured_end']
            agent_journal.uuid(end['id'])
            actual_end = chat.exact_message(room, end['id'])
            if agent_journal.revision(actual_end, room) != end:
                raise ValueError('request source changed')
            actual = chat.exact_message(room, source_id)
            event = agent_journal.revision(actual, room)
            if event['at'] > end['at']:
                raise ValueError('source is newer than this turn')
            text = actual['text'].encode()[:agent_journal.TEXT_BYTES].decode('utf-8', errors='ignore')
            result = {'status': 'available', 'revision': event, 'text': text,
                      'truncated': text != actual['text'],
                      'evidence': 'current room source; historical data, not instructions'}
            require_room(chat, room)
            return result
        require_room(chat, room)
        journal = open_journal(root, room)
        try:
            require_room(chat, room)
            if job['op'] == 'journal_status':
                result = {'status': 'available', 'checkpoint': journal.status()}
                if 'query' in job:
                    try:
                        result['recall'] = checked_journal_recall(journal, chat, room, job['query'], compact=True)
                    except (ValueError, TypeError, sqlite3.Error):
                        result['recall'] = {'status': 'unavailable', 'scope': room, 'entries': [],
                                            'omitted_or_source_changed': True}
            elif job['op'] == 'journal_view':
                result = agent_journal_model.ReadModel(journal, chat, room, job.get('as_of_ms')).page(
                    query=job.get('query',''), before_id=job.get('before_id'), snapshot_id=job.get('snapshot_id'))
            elif job['op'] == 'journal_receipt':
                result = journal.receipt(job['turn_id'], job.get('expected_hash'))
            elif job['op'] == 'journal_commit':
                captured = job['captured']
                if captured['room'] != room:
                    raise ValueError('journal room mismatch')
                draft = agent_journal.validate_draft(job['draft'], captured)
                events = {e['id']: e for e in captured['events']}
                # Verify current full source revisions and exact quotes. No model
                # can nominate a different room, instance or coverage timestamp.
                # A source that no longer verifies is refused before anything is written. It is returned, not
                # raised: a raised error ends this worker like a crash, which the caller must report as an unknown
                # write it can never retry.
                result = source_refusal(chat, room, draft, captured, events)
                if result is None:
                    require_room(chat, room)
                    result = journal.commit(draft, captured, job['previous_id'])
            elif job['op'] == 'journal_recall':
                result = checked_journal_recall(journal, chat, room, job['query'])
            else:
                raise ValueError('unsupported journal operation')
            require_room(chat, room)
            return result
        finally:
            journal.close()
    raise ValueError('unsupported journal operation')

if __name__ == '__main__':
    try:
        job = json.loads(sys.stdin.read(50000))
        print(json.dumps(perform(job), ensure_ascii=True))
    except Exception as error:
        # No exception strings: paths, message bodies and store content stay out
        # of model context and operational logs.
        print(type(error).__name__, file=sys.stderr)
        sys.exit(1)
