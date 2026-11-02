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
from agent_memory import RoomMemory
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


def perform(job, chat=None):
    cfg = job['config']
    chat = chat or Chat(cfg['cli'], cfg['memory_timeout_s'])

    def access(room):
        for listed in chat.member_rooms():
            if listed.get('id') != room:
                continue
            # Current server contract: ordinary rooms omit kind; DMs say kind=dm.
            # Require the positive normal-room metadata too; malformed/unknown
            # discovery results must never fall through to shared memory.
            if ('kind' not in listed and not listed.get('dm') and
                    listed.get('visibility') in ('public', 'private') and
                    isinstance(listed.get('members'), list)):
                return 'shared'
        return None

    store = RoomMemory(Path(cfg['memory_instance']), access)
    room = job['room']
    if job['op'].startswith('journal_'):
        if cfg.get('journal_enabled') is not True:
            raise ValueError('journal not enabled')
        if job['op'] == 'journal_source':
            # Read through the current actor's normal room transport, not a
            # journal import or a cross-room/filesystem lookup. No DB is opened.
            store._allowed(room)
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
            store._allowed(room)
            return result
        # Reuse the existing instance, room-directory and membership boundary.
        memory = store._open(room)
        path = memory.path
        memory.close()
        journal = agent_journal.Journal(path)
        try:
            store._allowed(room)
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
                    store._allowed(room)
                    result = journal.commit(draft, captured, job['previous_id'])
            elif job['op'] == 'journal_recall':
                result = checked_journal_recall(journal, chat, room, job['query'])
            else:
                raise ValueError('unsupported journal operation')
            store._allowed(room)
            return result
        finally:
            journal.close()
    if job['op'] == 'recall':
        text, sources = store.recall(room, job['query'], max_chars=cfg['recall_cap_chars'])
        return {'text': text, 'sources': sources}
    if job['op'] != 'record':
        raise ValueError('unsupported memory operation')
    event = job['event']
    messages = chat.read(room, cfg['history_n'])
    source = next((m for m in messages if m.get('id') == event['source']), None)
    reply = next((m for m in messages if m.get('id') == event['reply_id']), None)
    if (not source or not reply or source.get('roomId') != room or reply.get('roomId') != room or
            source.get('at') != event['at'] or
            (source.get('text') or '')[:cfg['message_cap_chars']] != event['text'] or
            (reply.get('from') or {}).get('sessionId') != cfg['self_session_id'] or
            reply.get('text') != event['reply']):
        raise ValueError('source or own confirmed reply not verified in room readback')
    return {'id': store.record_confirmed(room, event['source'], event['at'], event['text'],
                                        event['reply'], event['reply_id'])}


if __name__ == '__main__':
    try:
        job = json.loads(sys.stdin.read(50000))
        print(json.dumps(perform(job), ensure_ascii=True))
    except Exception as error:
        # No exception strings: paths, message bodies and store content stay out
        # of model context and operational logs.
        print(type(error).__name__, file=sys.stderr)
        sys.exit(1)
