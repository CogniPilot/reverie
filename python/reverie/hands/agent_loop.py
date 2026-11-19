"""A bounded configurable chat loop with optional workspace coding tasks.

One pass (tick): read each configured room through the reverie chat CLI, pick messages that should wake the employee
(a DM, the owner, or an @mention), and answer each one once: bounded prompt -> local model -> post.

Bounded by construction:
- The prompt is identity + memory + recent room history + the waking message, each capped, history FIFO-trimmed to
  a fixed character budget. Nothing accumulates between turns, so there is no compaction step to block on.
- With search on, that budget also keeps room for every search round (search_reserve), and each round's additions
  are capped. Every request is measured before it is sent, and one over prompt_cap_chars is never sent.
- The state file keeps a capped set of seen ids per room.
Claims: a message is claimed in the state file before the post and marked done after. A claim left by a crash is
settled by looking for a post of ours in that room newer than the claimed message; only if there is none is it answered
again, once. This is biased to a missed reply over a double one, but it is not exactly-once: a post that times out
here and still commits on the server after the retry gives two replies.
Errors in one message or room are logged and skipped; the loop carries on. supervise.sh restarts the process on a crash.

r3 adds two optional steps, both off by default:
- vision: image attachments on the waking message go to the model as image_url parts (base64 data URIs). Laptops
  download by room/file ID through the normal scoped chat CLI. Native legacy configurations read only files under
  attachments_root/<room id>/. Type, magic-byte, size and count limits apply to both paths.
- search: the model may call one tool, web_search, at most search_max_calls times per answer. Results are capped and
  framed as untrusted data. A reply that used results carries the [web] marker, and every query is logged.

r5 finishes a search answer safely. Once the search budget is spent, or the model answers with tool-call markup or
nothing, the tools are withdrawn and one short instruction (FINAL_NOTE) asks for a plain-text answer from the results
already given. If that reply is still unusable, the instruction is replaced (not stacked) by RETRY_NOTE for one more
try; after that a fixed FAIL_LINE is posted. Markup is never run as a search and never posted. Both notes are part of
search_reserve, so they fit prompt_cap_chars. Each answer logs its model and search times.
With "rooms": "auto" the loop reads the rooms the server says she is a member of (one query per tick, DMs by kind).
A failed query reads nothing that tick. Membership is checked again right before each post; a room she has left gets
no post. The same query gives the id of each room's newest message; a room is read again only when that id changed
(or is missing), a claim is pending, or its last read stopped early. Each line of the prompt carries its time ("[5m ago]", "[9:16 AM EDT]").
"""
import json
import math
import os
import re
import signal
import subprocess
import sys
import threading
import time
from time import monotonic as room_list_clock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import coding_chat
from coding_manager import TaskManager
from coding_process import Terminal, WorkerSocket
import agent_journal

_terminal = None
OFFICE_DISABLED_STATUS = 'disabled by office configuration (all automatic room replies blocked)'
PHONE_STATUS = {
    'unscoped': 'unavailable (no scoped laptop phone)',
    'active': 'active',
    'office_disabled': OFFICE_DISABLED_STATUS,
    'unavailable': 'unavailable; polling fallback',
}

ROOM_LIST_LOG_INTERVAL_S = 60  # report a continuing office outage at most once a minute
SEARCH_SETTINGS = ('search_url', 'search_results', 'search_timeout_s', 'search_max_bytes')


def log(*a):
    if _terminal is not None:
        _terminal.log(*a)
        return
    print(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), *a, flush=True)


def terminal_event(cfg, kind, **data):
    view = cfg.get('_terminal')
    if view is not None:
        try:
            view.event(kind, **data)
        except Exception:
            pass  # A display failure cannot change whether a room receives its reply.


def load_json(path, default):
    result = poll_request('load', path=os.fspath(path))
    return result['value'] if result['present'] else default


def save_json(path, data):
    poll_request('save', path=os.fspath(path), data=data)


class ChatNotFound(RuntimeError, ValueError):
    """The chat server answered that the room has no such message: a definite answer, unlike a timeout or a failed
    call. It is still the RuntimeError or ValueError that callers already treat as an unreadable message."""


class Chat:
    """Client of the parent-bound native Office chat worker."""

    def __init__(self, argv, timeout):
        self.argv, self.timeout = list(argv), timeout
        self.time_zone = None

    def _call(self, kind, **fields):
        request = agent_journal.encode_memory_json({
            'cli': self.argv, 'timeout_s': self.timeout, 'operation': {'kind': kind, **fields},
        })
        reply = agent_journal.native_memory_request(
            'hands-office-chat-worker', request, 1048576, timeout=self.timeout + 2,
        ) if request is not None else None
        status = reply.get('status') if reply else None
        if status == 'ok':
            return reply['value']
        if status == 'not_found':
            raise ChatNotFound('no such message in this room')
        if status == 'timeout':
            raise subprocess.TimeoutExpired('chat ' + kind, self.timeout)
        if status == 'invalid':
            raise ValueError(reply['reason'])
        raise RuntimeError('Office chat ' + kind + ' unavailable')

    def read(self, room, n):
        data = self._call('history', room=room, count=str(n))
        if data['timeZone'] is not None:
            self.time_zone = data['timeZone']
        return data['messages']

    def turn_summary(self):
        return self._call('summary')

    def exact_message(self, room, message_id):
        return self._call('exact', room=room, id=message_id)

    def phone_allows(self, room, message_id):
        return self.exact_message(room, message_id)['phoneWake']

    def member_alert(self, room, session_id):
        return self._call('member_alert', room=room, session=session_id)

    def say(self, room, text, reply_to=None):
        return self._call('say', room=room, text=text, reply_to=reply_to)

    def member_rooms(self):
        return self._call('rooms')


def model_settings(cfg):
    payload = {'model': cfg['model'], 'max_tokens': cfg['reply_max_tokens'], 'stream': False}
    if 'temperature' in cfg:
        payload['temperature'] = cfg['temperature']
    meter = dict(cfg['token_meter']) if cfg.get('token_meter') else None
    if meter is not None and cfg.get('vision'):
        meter['image_tokens_per_image'] = cfg.get('image_tokens_per_image', 2048)
    return {'api_base': cfg['api_base'], 'key_env': cfg.get('model_key_env'), 'timeout_s': cfg['model_timeout_s'],
            'max_response_bytes': 262144, 'token_meter': meter, 'events_file': cfg.get('model_events_file'),
            'payload': payload}


def chat_model(cfg, messages, tools=None):
    job = model_settings(cfg)
    job['payload']['messages'] = messages
    if tools:
        job['payload']['tools'] = tools
    coding_chat.report_managed_context(cfg)
    return coding_chat.model_completion(job)


def web_request(action, *, timeout=3, **fields):
    args = json.dumps(dict(action=action, **fields)).encode('ascii')
    return agent_journal.native_memory_request('hands-web-worker', args, 32768, timeout=timeout)


def fetch_public_page(url):
    result = web_request('fetch', url=url, timeout=9)
    if not result or not isinstance(result.get('text'), str):
        raise ValueError('Public web read unavailable')
    return result['text']


def searxng_search(cfg, query):
    result = web_request('search', query=query, timeout=cfg['search_timeout_s'] + 1,
                         settings={key: cfg[key] for key in SEARCH_SETTINGS})
    if not result or not isinstance(result.get('text'), str):
        raise ValueError('Configured web search unavailable')
    return result['text']


def append_diagnostic(path, record):
    if not path:
        return
    result = web_request('append_diagnostic', path=path, line=json.dumps(record, ensure_ascii=True))
    if not result or result.get('ok') is not True:
        raise OSError('Hands diagnostic log unavailable')


def write_turn_trace(cfg, record):
    """Append one content-free turn record (owner-only, like web_log). No-op unless turn_trace_file is set."""
    append_diagnostic(cfg.get('turn_trace_file'), record)


def hands_request(worker, payload):
    reply = agent_journal.native_memory_json('hands-' + worker + '-worker', payload, agent_journal.TURN_CAPTURE_BYTES)
    if reply is None:
        raise ValueError(f'Hands {worker} worker unavailable')
    if 'error' in reply:
        raise ValueError(reply['error'])
    return reply


def prompt_request(action, **fields):
    return hands_request('prompt', {action: fields})


def poll_request(action, **fields):
    return hands_request('poll', {action: fields})


def incoming_event(cfg, room, message, sender=None):
    if cfg.get('_terminal') is not None:
        try:
            preview = prompt_request('preview', message=message, cap=cfg['message_cap_chars'])
            terminal_event(cfg, 'incoming', room=room, sender=sender or preview['sender'], text=preview['text'])
        except ValueError:
            pass


def alert_allows(cfg, chat, room, msg):
    # Production Chat rechecks the server's single phone policy before inference AND before posting.
    # In-process fixture/legacy adapters below retain their old explicit member-alert interface.
    accepted = getattr(chat, 'phone_allows', None)
    if callable(accepted):
        try:
            value = accepted(room, msg['id'])
            if type(value) is not bool:
                raise ValueError('invalid phone acceptance')
            return value
        except Exception as error:
            log('phone acceptance unavailable; no reply', room, type(error).__name__)
            return False
    try:
        current = chat.member_alert(room, cfg['self_session_id'])
        lease = current['lease']
        if lease is None:
            return True
        if (not isinstance(lease, dict) or lease.get('mode') not in ('ring', 'vibrate', 'silent') or
                type(lease.get('until')) not in (int, float) or not math.isfinite(lease['until'])):
            raise ValueError('room view has an invalid alert lease')
        if lease['mode'] != 'silent' or lease['until'] <= time.time() * 1000:
            return True
        sender = msg.get('from') or {}
        if sender.get('kind') != 'user' or sender.get('mark') not in ('owner_typed', 'owner_spoken'):
            return False
        if re.search(r'(^|[^\w@])@everyone(?![\w-])', msg.get('text') or '', re.I | re.ASCII) is not None:
            return True
        name = current.get('name')
        if not current.get('unique') or not isinstance(name, str) or not name.strip():
            return False
        return re.search(r'(^|[^\w@])@' + re.escape(name) + r'(?![\w-])',
                         msg.get('text') or '', re.I | re.ASCII) is not None
    except Exception as error:
        log('alert mode unavailable; preserving current wake behavior', room, repr(error)[:200])
        return True


def image_settings(cfg):
    return {'vision': bool(cfg.get('vision')), 'root': cfg.get('attachments_root'),
            'session': cfg.get('self_session_id'), 'cli': cfg['cli'], 'max_images': cfg['max_images'],
            'max_bytes': cfg['max_image_bytes'], 'timeout': cfg['cli_timeout_s']}


def load_images(cfg, room, msg):
    if not msg.get('attachments'):
        return [], []
    reply = agent_journal.native_memory_json('hands-images-worker', {
        'room': room, 'message': msg, 'settings': image_settings(cfg),
    }, agent_journal.TURN_CAPTURE_BYTES, timeout=14 * 20 + 3)
    if reply is None:
        raise ValueError('Hands image worker unavailable')
    for name, reason in reply['failures']:
        log('image skipped', room, msg.get('id'), name, reason)
    return reply['parts'], reply['notes']


def measure_prompt(messages, tools=None, pending=None):
    # Image data stays with the model transport and is bounded separately there.
    text_messages = [
        dict(message, content=[part for part in message['content'] if part.get('type') == 'text'])
        if isinstance(message.get('content'), list) else message for message in messages
    ]
    return prompt_request('prepare', job={'messages': text_messages, 'tools': tools, 'pending': pending})


def request_chars(messages, tools=None):
    return measure_prompt(messages, tools)['characters']


def pending_summary(cfg):
    try:
        source = cfg.get('_turn_summary')
        text = source() if callable(source) else Chat(cfg['cli'], min(cfg.get('cli_timeout_s', 60), 2)).turn_summary()
        return text if isinstance(text, str) else None
    except Exception:
        return None


def turn_context(cfg, messages, tools=None):
    reply = measure_prompt(messages, tools, {
        'text': pending_summary(cfg), 'prompt_cap': cfg['prompt_cap_chars'],
    })
    if reply['snapshot'] is not None:
        messages = messages[:2] + [reply['snapshot']] + messages[2:]
    return coding_chat.inject_managed_context(cfg, messages, reply['characters'])


def turn_request(action, **fields):
    return hands_request('turn', {'action': action, **fields})


def web_policy(cfg):
    return {'search': bool(cfg.get('search')), 'fetch': bool(cfg.get('web_fetch')),
            'max_calls': cfg['search_max_calls'], 'result_chars': cfg['search_result_chars']}


def wake_scope(cfg, room):
    return {'direct': room in cfg.get('dm_rooms', []) or room in cfg.get('_auto_dms', ()),
            'name': cfg.get('self_name'), 'session': cfg.get('self_session_id')}


def prompt_job(cfg, history, msg, room, now, reserve, recalled, notes):
    settings = {key: cfg[key] for key in ('system_preamble', 'timezone', 'identity_cap_chars', 'memory_cap_chars',
                                        'message_cap_chars', 'prompt_cap_chars')}
    settings.update(reported_zone=cfg.get('_time_zone'), identity_file=cfg.get('identity_file'),
                    memory_file=cfg.get('memory_file'), recall_cap_chars=cfg.get('recall_cap_chars', 3000))
    return {
        'settings': settings, 'scope': wake_scope(cfg, room), 'room': room, 'history': history,
        'message': msg, 'notes': notes, 'now': time.time() if now is None else now,
        'reserve': reserve, 'recalled': recalled,
    }


def build_prompt(cfg, history, msg, room=None, now=None, reserve=0, recalled=""):
    images, notes = load_images(cfg, room, msg) if room is not None else ([], [])
    text = prompt_request('build', job=prompt_job(cfg, history, msg, room, now, reserve, recalled, notes))
    user = text['user']
    content = [{'type': 'text', 'text': user}] + images if images else user
    return [{'role': 'system', 'content': text['system']}, {'role': 'user', 'content': content}], text['characters']


def answer(cfg, room, history, msg, model, search, timing=None, recalled="", fetch=fetch_public_page, *, journal_operation=None):
    """_answer, plus one content-free record in turn_trace_file (when set) for every reply, failure or error."""
    steps = []
    started = time.monotonic()
    outcome = 'error'
    try:
        result = _answer(cfg, room, history, msg, model, search, timing, recalled, fetch, steps, journal_operation)
        outcome = result['outcome']
        return result['answer'], result['characters'], result['searches']
    except BaseException as e:
        outcome = 'error:' + type(e).__name__
        raise
    finally:
        if cfg.get('turn_trace_file'):
            try:
                write_turn_trace(cfg, {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'room': room,
                                       'msg': msg.get('id'), 'outcome': outcome,
                                       'seconds': round(time.monotonic() - started, 2), 'steps': steps[:24]})
            except Exception as e:
                log('turn trace not written', type(e).__name__)


def _answer(cfg, room, history, msg, model, search, timing, recalled, fetch, steps, journal_operation):
    start_task = cfg.get('_admin_start_task')
    workspace_options = None
    if start_task is not None:
        controls = coding_chat.workspace_controls()
        offered = getattr(start_task, 'tools', None)
        workspace_options = {'tools': offered if isinstance(offered, list) else controls['tools'],
                             'reserve_tools': controls['tools'], 'rule': controls['rule'],
                             'cancel_rule': controls['cancel_rule']}

    failures = []
    if journal_operation is None and custom_memory_worker(cfg) is not None:
        def journal_operation(op, **payload):
            return memory_op(cfg, room, op, failures=failures, **payload)

    memory = None
    if room is not None and cfg.get('journal_enabled') and cfg.get('memory_instance'):
        memory = {'automatic': room not in cfg.get('journal_auto_recall_exclude_rooms', []),
                  'max_chars': cfg.get('recall_cap_chars', 3000),
                  'native': agent_journal.journal_memory(cfg, room) if journal_operation is None else None}
    job = {'prompt': prompt_job(cfg, history, msg, room, None, 0, recalled, []),
           'web': web_policy(cfg), 'workspace': workspace_options, 'memory': memory,
           'images': image_settings(cfg) if room is not None and msg.get('attachments') else None,
           'prompt_cap': cfg['prompt_cap_chars'], 'managed': bool(cfg.get('managed_context')),
           'summary': bool(cfg.get('cli')) or callable(cfg.get('_turn_summary')),
           'runtime': reply_runtime(cfg, room, msg, model, search, fetch)}

    def legacy_memory(event):
        request = event['request']
        return agent_journal.journal_effect(journal_operation, request, failures,
                                            request['op'] in ('journal_commit', 'journal_receipt'))

    def workspace(event):
        call = event['call']
        return {'reply': start_task.cancel() if call['action'] == 'cancel' else start_task(call['brief'])}

    effects = {
        'summary': lambda event: {'text': pending_summary(cfg)},
        'model': lambda event: {'output': model(cfg, event['messages'], event['tools'])},
        'web_fetch': lambda event: external_web(fetch, event['argument'], public=True),
        'web_search': lambda event: external_web(search, cfg, event['argument']),
        'memory': legacy_memory,
        'workspace': workspace,
    }
    return drive_reply(cfg, job, effects, steps, timing)


def reply_runtime(cfg, room, message, model, search, fetch):
    managed = None
    if cfg.get('managed_context'):
        managed = {'state_file': cfg['state_file'], 'session': cfg['self_session_id'],
                   'started': bool(cfg.get('_managed_context_started'))}
    return {'cli': cfg.get('cli'), 'cli_timeout_s': cfg.get('cli_timeout_s', 60),
            'provided_summary': callable(cfg.get('_turn_summary')) or model is not chat_model,
            'managed': managed, 'model': model_settings(cfg) if model is chat_model else None,
            'room': room, 'message_id': message.get('id'), 'web_log': cfg.get('web_log'),
            'web_settings': {key: cfg[key] for key in SEARCH_SETTINGS},
            'external_search': search is not searxng_search, 'external_fetch': fetch is not fetch_public_page}


def external_web(callback, *args, public=False):
    try:
        return {'text': callback(*args)}
    except Exception as error:
        return {'text': 'Public web read unavailable.' if public else 'Search failed: ' + repr(error)[:200]}


def drive_reply(cfg, job, effects, steps, timing):
    bound = agent_journal.TURN_CAPTURE_BYTES
    worker = WorkerSocket('hands-answer-worker', job, environment=os.environ,
                          startup_limit=bound, reply_limit=bound)
    try:
        while True:
            event = worker.wait(max(288, cfg.get('model_timeout_s', 300) + 5))
            if 'effect' in event:
                worker.send(effects[event['effect']](event))
            elif 'error' in event:
                error = TimeoutError if event.get('timeout') else RuntimeError
                raise error(event['error'])
            elif 'answer' in event:
                return event
            else:
                observe_reply(cfg, event, steps, timing)
    finally:
        worker.close(grace=0.1)


def observe_reply(cfg, event, steps, timing):
    if 'trace' in event and len(steps) < 24:
        steps.append(event['trace'])
    if 'timing' in event and timing is not None:
        kind, elapsed, details = event['timing']
        timing.append((kind, round(elapsed, 2), details))
    if 'observe' in event:
        terminal_event(cfg, event['observe'], **event['data'])
    if 'log' in event:
        log(*event['log'])
    if update := event.get('managed'):
        if 'started' in update:
            cfg['_managed_context_started'] = True
            cfg['_managed_context_pending'] = update.get('pending')
        if 'reported' in update:
            cfg.pop('_managed_context_pending', None)
            if update['reported']:
                cfg['_managed_context_reported'] = True


def timing_text(timing):
    """model/search seconds per step, e.g. m12.3(p4100/1.2s,g210/9.8s),s1.1,m3.0. p = prompt tokens newly processed
    and prefill seconds, g = generated tokens and generation seconds (llama.cpp timings, when the server sends them)."""
    parts = []
    for kind, secs, t in timing:
        part = f'{kind[0]}{secs}'
        if isinstance(t, dict):
            try:
                part += f"(p{int(t.get('prompt_n', 0))}/{float(t.get('prompt_ms', 0)) / 1000:.1f}s," \
                        f"g{int(t.get('predicted_n', 0))}/{float(t.get('predicted_ms', 0)) / 1000:.1f}s)"
            except (TypeError, ValueError):
                pass
        parts.append(part)
    return ','.join(parts) or '-'


def room_list_status(cfg, error):
    now = room_list_clock()
    if error is None:
        outage = cfg.pop('_room_list_outage', None)
        if outage is not None:
            log('room list recovered', f"failures={outage['failures']}",
                f"elapsed_s={int(now - outage['started'])}")
        return
    outage = cfg.get('_room_list_outage')
    if outage is None:
        cfg['_room_list_outage'] = {'started': now, 'last_log': now, 'failures': 1}
        log('room list failed, reading no room this tick', error)
    else:
        outage['failures'] += 1
        if now - outage['last_log'] >= ROOM_LIST_LOG_INTERVAL_S:
            log('room list still unavailable, reading no rooms',
                f"failures={outage['failures']}", f"elapsed_s={int(now - outage['started'])}")
            outage['last_log'] = now
    cfg['_auto_dms'] = set()


JOURNAL_COMMAND_OPS = ('journal_recall', 'journal_view', 'journal_receipt', 'journal_source', 'journal_commit')


def custom_memory_worker(cfg):
    directory = os.path.dirname(os.path.abspath(__file__))
    default = os.path.join(directory, 'agent_memory_worker.py')
    selected = os.path.join(directory, cfg.get('memory_worker_name', 'agent_memory_worker.py'))
    return selected if os.path.realpath(selected) != os.path.realpath(default) else None


def memory_op(cfg, room, op, *, failures=None, **payload):
    """Optional legacy memory adapter. Failure leaves the original claim and POST alone.

    Journal commands make several network source checks, so they get their own bounded time limit. When
    `failures` is a list, the failure class ('timeout' or 'worker_error') is appended to it."""
    script = custom_memory_worker(cfg)
    if (script is None or not cfg.get('memory_instance') or
            room in set(cfg.get('dm_rooms', [])) | set(cfg.get('_auto_dms', []))):
        return None
    process = None
    try:
        job = dict(config=agent_journal.automatic_config(cfg), room=room, op=op, **payload)
        command = [sys.executable, '-I', '-B', script]
        process = subprocess.Popen(command, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   start_new_session=True)
        timeout = (cfg.get('journal_command_timeout_s', 8) if op in JOURNAL_COMMAND_OPS else
                   cfg.get('journal_status_timeout_s', 5) if op == 'journal_status' else cfg['memory_timeout_s'])
        output, _ = process.communicate(json.dumps(job), timeout=timeout)
        if process.returncode != 0 or len(output) > 50000:
            raise ValueError('memory operation refused')
        result = json.loads(output)
        if not isinstance(result, dict):
            raise ValueError('invalid memory result')
        if op == 'recall' and (not isinstance(result.get('text'), str) or
                               len(result['text']) > cfg['recall_cap_chars']):
            raise ValueError('memory result too large')
        return result
    except Exception as error:
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
        log('memory unavailable', op, type(error).__name__)
        if failures is not None:
            failures.append('timeout' if isinstance(error, subprocess.TimeoutExpired) else 'worker_error')
        return None


def tick(cfg, chat, state, model=chat_model, search=searxng_search):
    """Run the native room pass with the existing optional coding and memory effects."""
    settings = {'rooms': None if cfg['rooms'] == 'auto' else cfg['rooms'],
                'dm_rooms': cfg.get('dm_rooms', []), 'name': cfg.get('self_name'),
                'session': cfg.get('self_session_id'), 'max_rooms': cfg['max_rooms'],
                'history_n': cfg['history_n'], 'max_answers': cfg['max_answers_per_tick'],
                'reply_chars': cfg['reply_cap_chars'], 'message_chars': cfg['message_cap_chars'],
                'coding': bool(cfg.get('coding')), 'coordinator': bool(cfg.get('_coding_manager')),
                'preview': cfg.get('_terminal') is not None}
    office = {'cli': chat.argv, 'timeout_s': chat.timeout} if type(chat) is Chat else None
    job = {'settings': settings, 'state': state, 'path': cfg['state_file'], 'office': office,
           'memory': tick_memory(cfg)}
    bound = agent_journal.TURN_CAPTURE_BYTES
    worker = WorkerSocket('hands-tick-worker', job, environment=os.environ,
                          startup_limit=bound, reply_limit=bound, send_limit=bound)
    try:
        while True:
            event = worker.wait(max(90, cfg.get('cli_timeout_s', 60) * 2 + 5))
            if 'effect' in event:
                result = tick_effect(cfg, chat, state, model, search, event)
                worker.send(result)
            elif 'error' in event:
                raise ValueError(event['error'])
            elif 'posted' in event:
                return event['posted']
            else:
                tick_observation(cfg, state, event)
    finally:
        worker.close(grace=0.1)


def tick_observation(cfg, state, event):
    if 'state' in event:
        patch = event['state']
        for room in patch['remove']:
            state.pop(room, None)
        state.update(patch['set'])
        if any(key == '_auto_dms' for key, _ in patch['set']):
            cfg['_auto_dms'] = set(state['_auto_dms'])
    elif 'time_zone' in event:
        cfg['_time_zone'] = event['time_zone']
    elif 'room_list' in event:
        room_list_status(cfg, event['room_list']['error'])
    else:
        observe_reply(cfg, event, [], None)


def tick_effect(cfg, chat, state, model, search, event):
    effect = event['effect']
    if effect == 'answer':
        return tick_answer(cfg, state, model, search, event)
    if effect == 'memory':
        request = event['request']
        return memory_op(cfg, event['room'], request.pop('op'), **request)
    if effect == 'before_chat':
        try:
            cfg['_coding_manager'].before_chat()
            return {}
        except Exception as error:
            return {'failure': repr(error)[:300]}
    if effect == 'alert':
        return alert_allows(cfg, chat, event['room'], event['message'])
    return tick_chat(chat, event['operation'])


def tick_memory(cfg):
    if not cfg.get('memory_instance'):
        return {'mode': 'disabled'}
    if custom_memory_worker(cfg) is not None:
        return {'mode': 'external'}
    return {'mode': 'native', 'config': agent_journal.automatic_config(cfg),
            'timeout_s': cfg['memory_timeout_s'], 'recall_chars': cfg['recall_cap_chars']}


def tick_chat(chat, operation):
    try:
        kind = operation['kind']
        if kind == 'rooms':
            value = chat.member_rooms()
        elif kind == 'history':
            messages = chat.read(operation['room'], int(operation['count']))
            zone = getattr(chat, 'time_zone', None)
            value = {'messages': messages, 'timeZone': zone if isinstance(zone, str) else None}
        else:
            value = chat.say(operation['room'], operation['text'], reply_to=operation['reply_to'])
        return {'value': value}
    except Exception as error:
        return {'error': {'name': type(error).__name__, 'detail': repr(error)[:300]}}


def tick_answer(cfg, state, model, search, event):
    timing = []
    try:
        reply, size, searches = room_answer(cfg, state, model, search, event, timing)
        result = {'reply': reply, 'characters': size, 'searches': searches, 'timing': timing_text(timing)}
    except Exception as error:
        result = {'failure': repr(error)[:300]}
    result['coding'] = {key: state[key] for key in ('_coding', '_coding_epoch') if key in state}
    return result


def room_answer(cfg, state, model, search, event, timing):
    room, history, msg = event['room'], event['history'], event['message']
    manager = cfg.get('_coding_manager')
    if event['control']:
        reply = (manager.control(state, room, history, msg) if manager else
                 'Coding task refused: background task manager is not running.')
        return reply, 0, 0
    cfg['_admin_start_task'] = coding_chat.workspace_callback(cfg, manager, state, room, history, msg)
    try:
        return answer(cfg, room, history, msg, model, search, timing, recalled=event['recalled'])
    finally:
        cfg.pop('_admin_start_task', None)


def terminal_prompt(cfg, text, history, model=chat_model, search=searxng_search):
    """A terminal-only conversation. It never posts to a room or invokes coding controls."""
    view = cfg['_terminal']
    if text == '/quit':
        view.quit_requested = True
        return
    if text == '/status':
        terminal_event(cfg, 'note', text=view.summary())
        return
    if text == '/help':
        terminal_event(cfg, 'note', text='Type a prompt to chat here. /status shows runtime observations; '
                       '/clear clears this terminal conversation; /quit exits. Ctrl+C exits during a request. '
                       'PgUp/PgDn scroll. Terminal prompts are not posted to rooms.')
        return
    if text == '/clear':
        history.clear()
        view.clear()
        terminal_event(cfg, 'note', text='Terminal conversation cleared.')
        return
    if text.startswith('/'):
        terminal_event(cfg, 'note', text='Unknown terminal command. Use /help.')
        return
    # Whole, like a room message: the prompt decides what fits and says what it cuts.
    msg = {'id': 'terminal-' + str(time.time_ns()), 'at': time.time() * 1000,
           'from': {'kind': 'user', 'name': 'You'}, 'text': text}
    incoming_event(cfg, 'terminal', msg, sender='You')
    manager = cfg.get('_coding_manager')
    if manager:
        manager.before_chat()
    reply, _, _ = answer(cfg, None, history, msg, model, search)
    if not reply:
        raise RuntimeError('empty terminal reply')
    sent = reply[:cfg['reply_cap_chars']]
    terminal_event(cfg, 'local_reply', room='terminal', text=sent)
    history.extend([msg, {'id': msg['id'] + '-reply', 'at': time.time() * 1000,
                         'from': {'kind': 'agent', 'name': cfg['self_name']}, 'text': sent}])
    del history[:-max(2, min(200, cfg['history_n'] * 2))]


def default_config():
    return coding_chat.native_settings('defaults')['settings']


def load_config(path):
    cfg = coding_chat.native_settings('startup', overrides=load_json(path, None) or {})['settings']
    cfg['_config_path'] = os.path.abspath(path)
    return cfg


class AttentionWake:
    def __init__(self, cfg, report=lambda text: None, *, env=None):
        self.signal = threading.Event()
        self.stopped = threading.Event()
        self.worker_lock = threading.Lock()
        self.thread = self.worker = None
        self.report = report
        self.status = 'disabled'
        self.initial = None
        if cfg.get('phone_wake'):
            env = os.environ if env is None else env
            self.initial = dict(endpoint=env.get('REVERIE_API_URL'), worker=env.get('REVERIE_WORKER'),
                                parent_session=env.get('REVERIE_SESSION_ID'), session=cfg.get('self_session_id'))
            self.status = 'connecting'

    def start(self):
        if self.initial is not None and self.thread is None:
            try:
                self.worker = WorkerSocket('hands-attention-worker', self.initial)
            except (OSError, ValueError):
                self.update_status('unavailable')
                return self
            self.thread = threading.Thread(target=self.listen, name='hands-phone-wake', daemon=True)
            self.thread.start()
        return self

    def update_status(self, kind):
        status = PHONE_STATUS[kind]
        if status != self.status:
            self.status = status
            detail = ('. Manual reads and terminal prompts remain available.' if kind == 'office_disabled'
                      else '; general messages use the normal scan.')
            self.report('Phone wake: ' + status + detail)

    def listen(self):
        try:
            while not self.stopped.is_set():
                try:
                    notice = self.worker.wait(0.1)
                except TimeoutError:
                    continue
                status = notice['status']
                if notice['wake'] is True:
                    self.signal.set()
                self.update_status(status)
                if status == 'unscoped':
                    break
        except (EOFError, OSError, ValueError, KeyError, TypeError):
            if not self.stopped.is_set():
                self.update_status('unavailable')
        finally:
            self.close_worker()

    def close_worker(self):
        with self.worker_lock:
            self.worker.close()

    def close(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(2)
            self.close_worker()


def wait_for_scan(seconds, wake, view, manager=None):
    """Accepted phone traffic wakes the serial loop; UI and coding work remain responsive."""
    until = time.monotonic() + seconds
    while time.monotonic() < until and not view.quit_requested:
        if view.has_input() or wake.signal.is_set():
            break
        if manager and manager.active:
            manager.pump()
        wake.signal.wait(min(0.05, max(0, until - time.monotonic())))


def main(argv):
    global _terminal
    cfg = load_config(argv[1])
    if '--check-config' in argv:
        print('configuration ok; runtime endpoints and sandbox not exercised')
        return 0
    chat = Chat(cfg['cli'], cfg['cli_timeout_s'])
    once = '--once' in argv
    initial = load_json(cfg['state_file'], {})
    coding_chat.interrupt_requests(initial.setdefault('_coding', {}), lambda: save_json(cfg['state_file'], initial))
    manager = TaskManager(sys.modules[__name__], cfg, chat) if cfg.get('coding') else None
    cfg['_coding_manager'] = manager
    view = Terminal(cfg, interactive=False if '--no-tui' in argv or once else None).start()
    cfg['_terminal'] = view
    _terminal = view
    attention = AttentionWake(cfg, lambda text: terminal_event(cfg, 'note', text=text))
    cfg['_attention'] = attention
    if not once:
        attention.start()
    local_history = []
    try:
        log('start', 'rooms', 'auto' if cfg['rooms'] == 'auto' else len(cfg['rooms']),
            'model', cfg['model'], 'prompt_cap_chars', cfg['prompt_cap_chars'],
            'vision', bool(cfg['vision']), 'search', bool(cfg['search']),
            'general_scan_s', cfg['poll_s'], 'phone_wake', attention.status)
        while not view.quit_requested:
            attention.signal.clear()  # Signals arriving during this serial pass cause the next pass immediately.
            prompt = view.pending()
            if prompt is not None:
                try:
                    terminal_prompt(cfg, prompt, local_history)
                except Exception as error:
                    log('terminal prompt failed', repr(error)[:300])
                if view.quit_requested:
                    break
            state = manager.active['state'] if manager and manager.active else load_json(cfg['state_file'], {})
            terminal_event(cfg, 'poll')
            if cfg['rooms'] != 'auto':
                terminal_event(cfg, 'rooms', count=len(cfg['rooms']))
            try:
                tick(cfg, chat, state)
                if manager:
                    manager.pump()
                terminal_event(cfg, 'idle')
            except Exception as e:
                log('tick failed', repr(e)[:300])
            if once:
                break
            wait_for_scan(cfg['poll_s'], attention, view, manager)
    except KeyboardInterrupt:
        log('stopped by operator')
    finally:
        attention.close()
        try:
            if manager and manager.active:
                manager.finish({'status': 'stopped', 'reason': 'terminal_exit'}, post=False)
        finally:
            view.stop()
            _terminal = None
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
