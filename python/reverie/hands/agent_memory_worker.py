"""One bounded memory operation, launched by the harness in its own process group.

No service/owner credential is accepted here. Chat uses the harness's existing agent
CLI identity. The parent kills this entire process group when its deadline expires.
"""
import json
import sys
from pathlib import Path

# -I excludes the script directory. Only the explicitly deployed sibling modules
# are imported; never a cwd, HOME or another instance's code.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from agent_loop import Chat
from agent_memory import RoomMemory


def perform(job):
    cfg = job['config']
    chat = Chat(cfg['cli'], cfg['memory_timeout_s'])

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
