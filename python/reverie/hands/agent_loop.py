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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import coding_chat
from coding_manager import TaskManager
from coding_process import WorkerSocket
from debug_terminal import DebugTerminal
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


def chat_model(cfg, messages, tools=None):
    """One completion. Returns the message dict ({'content': ..., 'tool_calls': [...]})."""
    req_body = {'model': cfg['model'], 'messages': messages, 'max_tokens': cfg['reply_max_tokens'], 'stream': False}
    if 'temperature' in cfg:
        req_body['temperature'] = cfg['temperature']
    if tools:
        req_body['tools'] = tools
    meter = dict(cfg['token_meter']) if cfg.get('token_meter') else None
    if meter is not None and cfg.get('vision'):
        meter['image_tokens_per_image'] = cfg.get('image_tokens_per_image', 2048)
    coding_chat.report_managed_context(cfg)
    return coding_chat.model_completion({
        'api_base': cfg['api_base'], 'key_env': cfg.get('model_key_env'), 'timeout_s': cfg['model_timeout_s'],
        'max_response_bytes': 262144, 'token_meter': meter, 'events_file': cfg.get('model_events_file'),
        'payload': req_body,
    })


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


def log_web(cfg, room, mid, query, tool='web_search'):
    """Append one search to the owner-only web log before making its request."""
    append_diagnostic(cfg.get('web_log'), {
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'room': room, 'msg': mid,
        'tool': tool, 'query': query,
    })


TRACE_VERBS = ('save', 'recall', 'source', 'receipt', 'map', 'help')


def write_turn_trace(cfg, record):
    """Append one content-free turn record (owner-only, like web_log). No-op unless turn_trace_file is set."""
    append_diagnostic(cfg.get('turn_trace_file'), record)


# Every persisted field is one of these closed vocabularies, else 'other' (None stays None). No free text is kept.
TRACE_FINISH = ('stop', 'length', 'tool_calls', 'function_call', 'content_filter', 'end_turn', 'max_tokens', 'eos')
TRACE_STATUS = ('available', 'committed', 'conflict', 'not_found', 'ok', 'refused', 'unavailable', 'unknown')
TRACE_FAILURE = ('timeout', 'worker_error')
TRACE_REASONS = {'journal_unavailable': 'journal_unavailable', 'map_result_budget': 'map_result_budget',
                 'operation_payload_conflict': 'operation_payload_conflict', 'read_only_request': 'read_only_request',
                 'save_needs_reason_this_turn': 'save_needs_reason_this_turn', 'source_budget': 'source_budget',
                 'turn_budget': 'turn_budget', 'worker_unavailable': 'worker_unavailable',
                 'write outcome unresolved': 'write_outcome_unresolved', 'source_unavailable': 'source_unavailable',
                 'view_unavailable': 'view_unavailable', 'result_exceeds_budget': 'result_exceeds_budget',
                 'invalid_arguments_or_source': 'invalid_arguments_or_source',
                 'source_needs_message_id': 'source_needs_message_id', 'receipt_needs_message_id': 'receipt_needs_message_id'}


def pick(value, vocab):
    """value if it is exactly one of vocab; 'other' for anything else; None for no value."""
    if value is None:
        return None
    return value if isinstance(value, str) and value in vocab else 'other'


def reason_code(value):
    """The fixed code for a journal reason; its free-text tail (after ';') is never kept."""
    if value is None:
        return None
    return TRACE_REASONS.get(value.split(';')[0].strip(), 'other') if isinstance(value, str) else 'other'


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


def wake_scope(cfg, room):
    return {'direct': room in cfg.get('dm_rooms', []) or room in cfg.get('_auto_dms', ()),
            'name': cfg.get('self_name'), 'session': cfg.get('self_session_id')}


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


def load_images(cfg, room, msg):
    if not msg.get('attachments'):
        return [], []
    reply = agent_journal.native_memory_json('hands-images-worker', {
        'room': room, 'message': msg, 'settings': {
            'vision': bool(cfg.get('vision')), 'root': os.fspath(cfg['attachments_root']) if cfg.get('attachments_root') else None,
            'session': cfg.get('self_session_id'), 'cli': cfg['cli'],
            'max_images': cfg['max_images'], 'max_bytes': cfg['max_image_bytes'], 'timeout': cfg['cli_timeout_s'],
        },
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


def turn_context(cfg, messages, tools=None):
    """Refresh the request's ephemeral snapshots and return the measured size."""
    try:
        source = cfg.get('_turn_summary')
        text = source() if callable(source) else Chat(cfg['cli'], min(cfg.get('cli_timeout_s', 60), 2)).turn_summary()
    except Exception:
        text = None
    reply = measure_prompt(messages, tools, {
        'text': text if isinstance(text, str) else None, 'prompt_cap': cfg['prompt_cap_chars'],
    })
    if reply['snapshot'] is not None:
        messages = messages[:2] + [reply['snapshot']] + messages[2:]
    return coding_chat.inject_managed_context(cfg, messages, reply['characters'])


def turn_request(action, **fields):
    return hands_request('turn', {'action': action, **fields})


def web_policy(cfg):
    return {'search': bool(cfg.get('search')), 'fetch': bool(cfg.get('web_fetch')),
            'max_calls': cfg['search_max_calls'], 'result_chars': cfg['search_result_chars']}


def web_step(cfg, room, mid, search, fetch, step):
    argument = step['argument']
    kind = argument['kind']
    if kind == 'invalid':
        return step['invalid_result']
    value = argument['value']
    try:
        if kind == 'fetch':
            log_web(cfg, room, mid, value, tool='web_fetch')
        else:
            log_web(cfg, room, mid, value)
    except OSError as error:
        log('web log failed, search not run', room, mid, repr(error)[:200])
        return 'Search unavailable: the search log could not be written.'
    try:
        return fetch(value) if kind == 'fetch' else search(cfg, value)
    except Exception as error:
        return 'Public web read unavailable.' if kind == 'fetch' else 'Search failed: ' + repr(error)[:200]


def journal_step(journal, call, steps, tool):
    invoked = journal.invoke(call)
    if steps is not None:
        try:
            verb = (json.loads(call['function'].get('arguments') or '{}').get('command') or '').split()[:1]
        except (ValueError, AttributeError):
            verb = []
        verb = verb[0] if verb and verb[0] in TRACE_VERBS else tool
        done = invoked if isinstance(invoked, dict) else {}
        steps.append({'journal': verb, 'status': pick(done.get('status'), TRACE_STATUS),
                      'failure': pick(done.get('failure'), TRACE_FAILURE), 'reason': reason_code(done.get('reason'))})
    return turn_request('journal_replay', call=call, arguments=journal.replay,
                        result=agent_journal.encoded(invoked))['messages']


def build_prompt(cfg, history, msg, room=None, now=None, reserve=0, recalled=""):
    """Use native text framing and budgets, then attach the independently bounded image parts."""
    settings = {key: cfg[key] for key in ('system_preamble', 'timezone', 'identity_cap_chars', 'memory_cap_chars',
                                        'message_cap_chars', 'prompt_cap_chars')}
    settings.update(reported_zone=cfg.get('_time_zone'), identity_file=cfg.get('identity_file'),
                    memory_file=cfg.get('memory_file'), recall_cap_chars=cfg.get('recall_cap_chars', 3000))
    images, notes = load_images(cfg, room, msg) if room is not None else ([], [])
    text = prompt_request('build', job={
        'settings': settings, 'scope': wake_scope(cfg, room), 'room': room, 'history': history,
        'message': msg, 'notes': notes, 'now': time.time() if now is None else now,
        'reserve': reserve, 'recalled': recalled,
    })
    user = text['user']
    content = [{'type': 'text', 'text': user}] + images if images else user
    return [{'role': 'system', 'content': text['system']}, {'role': 'user', 'content': content}], text['characters']


def answer(cfg, room, history, msg, model, search, timing=None, recalled="", fetch=fetch_public_page):
    """_answer, plus one content-free record in turn_trace_file (when set) for every reply, failure or error."""
    steps = []
    started = time.monotonic()
    outcome = 'error'
    try:
        result = _answer(cfg, room, history, msg, model, search, timing, recalled, fetch, steps=steps)
        outcome = None
        return result
    except BaseException as e:
        outcome = 'error:' + type(e).__name__
        raise
    finally:
        if cfg.get('turn_trace_file'):
            try:
                if outcome is None:
                    outcome = turn_request('reply_outcome', reply=result[0])['outcome']
                write_turn_trace(cfg, {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'room': room,
                                       'msg': msg.get('id'), 'outcome': outcome,
                                       'seconds': round(time.monotonic() - started, 2), 'steps': steps[:24]})
            except Exception as e:
                log('turn trace not written', type(e).__name__)


def _answer(cfg, room, history, msg, model, search, timing=None, recalled="", fetch=fetch_public_page, steps=None):
    """Prompt -> (optional web_search steps) -> reply text. Returns (reply, request_chars, searches), where
    request_chars is the largest request actually sent.

    The prompt reserves room for search and every round's additions are capped, so each request fits
    prompt_cap_chars. Each one is still measured before it is sent; one over the cap raises instead (a missed reply).

    With search on: while searches remain, the tool is offered. When they are spent, or a reply is unusable (empty or
    tool-call markup), the answer is finished without tools: FINAL_NOTE, then at most one retry with RETRY_NOTE in its
    place, then FAIL_LINE. So there are at most search_max_calls + 2 model calls and never a search past the cap.
    `timing`, if given, collects ('model'|'search', seconds, server timings) per step."""
    failures = []
    cap = cfg.get('recall_cap_chars', 3000)
    journal = agent_journal.Turn(cfg, room, history, msg,
                                lambda op, **payload: memory_op(cfg, room, op, failures=failures, **payload),
                                failures=failures, evidence={'text': recalled, 'max_chars': cap})
    recalled = journal.merged_recall if journal.merged_recall is not None else journal.merge_recalled(recalled, cap)
    start_task = cfg.get('_admin_start_task')
    task_controls = coding_chat.workspace_controls() if start_task is not None else None
    offered = getattr(start_task, 'tools', None)
    task_tools = task_controls['tools'] if task_controls else []
    if isinstance(offered, list):
        task_tools = offered
    web = web_policy(cfg)
    reserve = prompt_request('reserve', job={
        'web': web, 'cap': cfg['prompt_cap_chars'], 'journal': bool(journal.context),
        'task': {key: task_controls[key] for key in ('rule', 'tools')} if task_controls else None,
        'summary': bool(cfg.get('cli')) or callable(cfg.get('_turn_summary')),
        'managed': bool(cfg.get('managed_context')),
    })
    try:
        messages, _ = build_prompt(cfg, history, msg, room, reserve=reserve['preferred'], recalled=recalled)
    except ValueError:
        # Optional pending context cannot displace required instructions or the current request.
        messages, _ = build_prompt(cfg, history, msg, room, reserve=reserve['required'], recalled=recalled)
    if task_controls:
        accepts_start = any(tool['function']['name'] == coding_chat.WORKSPACE_TASK_NAME for tool in task_tools)
        messages[0]['content'] += '\n' + task_controls['rule' if accepts_start else 'cancel_rule']
    if journal.context:
        messages[0]['content'] += journal.context
    searches = largest = 0
    stage = 'explore'
    def ask(plan, journal_names):
        nonlocal largest
        tools = plan['tools']
        charged_tools = (tools or None) if start_task is not None or web['fetch'] or journal.tools else None
        request, size = turn_context(cfg, messages, charged_tools)
        if size > cfg['prompt_cap_chars']:
            raise RuntimeError(f'request of {size} chars is over prompt_cap_chars, not sent')
        largest = max(largest, size)
        terminal_event(cfg, 'model_start', chars=size)
        t0 = time.monotonic()
        out = model(cfg, request, tools)
        out = {'content': out} if isinstance(out, str) else out
        if out.get('_token_meter_status') == 'unavailable':
            terminal_event(cfg, 'note', text='Token count unavailable: tokenizer timed out. Character, output and time limits still apply.')
        elapsed = time.monotonic() - t0
        decision_fields = {key: out.get(key) for key in ('content', 'tool_calls', '_context_overflow', '_finish_reason')}
        settled = turn_request('settle', state={'phase': plan['phase'], 'web': web, 'searches': searches,
                                               'journal_names': journal_names, 'output': decision_fields})
        if steps is not None:
            steps.append({'tools': bool(tools), 'finish': pick(out.get('_finish_reason'), TRACE_FINISH),
                          'outcome': settled['outcome'], 'ms': int(elapsed * 1000), 'chars': size})
        terminal_event(cfg, 'model_done', seconds=elapsed, model=out.get('_model'), usage=out.get('_usage'))
        if timing is not None:
            timing.append(('model', round(elapsed, 2), out.get('_timings')))
        return out, settled

    while True:
        journal_open = bool(journal.tools) and journal.calls < journal.call_limit
        plan = turn_request('plan', state={'stage': stage, 'web': web, 'searches': searches,
                                           'journal_available': bool(journal.tools),
                                           'journal_tools': journal.tools if journal_open else [],
                                           'task_tools': task_tools if start_task is not None else None})
        if plan['note'] is not None:
            note = {'role': 'user', 'content': plan['note']}
            if plan['replace_note']:
                messages[-1] = note
            else:
                messages.append(note)
        out, settled = ask(plan, journal.accepted_calls if journal_open else [])
        if plan['phase'] in ('direct', 'tools'):
            task_reply = coding_chat.invoke_workspace_tool(out, start_task)
            if task_reply is not None:
                return task_reply, largest, searches
        step = settled['decision']
        action = step['action']
        if action == 'done':
            if step['reason'] == 'limit' and plan['phase'] != 'direct':
                attempts = {'finish': 'finishing=1', 'retry': 'finishing=2'}
                extra = [attempts[plan['phase']]] if plan['phase'] in attempts else []
                log('answer cut at reply limit', room, msg.get('id'), f'searches={searches}', *extra)
            elif step['reason'] == 'unusable':
                log('answer unusable', room, msg.get('id'), out.get('_finish_reason'))
            elif step['reason'] == 'failed':
                log('answer unusable after retry', room, msg.get('id'), f'searches={searches}', 'finishing=2')
            return step['reply'], largest, searches
        if action in ('finish', 'retry'):
            stage = action
        elif action == 'journal':
            messages.extend(journal_step(journal, step['call'], steps, settled['outcome']))
        else:
            t0 = time.monotonic()
            result = web_step(cfg, room, msg.get('id'), search, fetch, step)
            if timing is not None:
                timing.append(('search', round(time.monotonic() - t0, 2), None))
            searches = step['searches']
            replay = turn_request('web_replay', call=step['call'], argument=step['argument'],
                                  visible=step['visible'], result=result, result_chars=web['result_chars'])
            messages.extend(replay['messages'])


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


def change_room(cfg, state, room, kind, **fields):
    state[room] = poll_request('change', room=state[room], event={'kind': kind, **fields})['room']
    save_json(cfg['state_file'], state)


def settle_claims(chat, cfg, state, room):
    for mid, claim in list(state[room].get('claims', {}).items()):
        try:
            result = poll_request('settlement', claim=claim, session=cfg['self_session_id'],
                                  history=chat.read(room, cfg['history_n']))
        except Exception as error:
            log('claim check failed', room, mid, type(error).__name__)
            continue
        if result['disposition']:
            log('claim ' + result['disposition'], room, mid)
            change_room(cfg, state, room, 'complete', id=mid)


def room_list(cfg, chat, state):
    """The rooms to read this tick. A fixed list from the config, or with "rooms": "auto" the rooms the server says
    this session is in (so adding or removing her is one room action; no config edit or restart). DMs are the rooms
    of kind "dm". At most max_rooms rooms, ids checked. If the list cannot be read, nothing is read this tick (fail
    closed): no stale list is used, and the saved list and per-room state are kept for the next good list.
    A room that was gone and comes back starts again from "now", like a room seen for the first time."""
    if cfg['rooms'] != 'auto':
        return cfg['rooms']
    try:
        result = poll_request('rooms', listed=chat.member_rooms(), state=state, cap=cfg['max_rooms'])
    except Exception as e:
        now = time.monotonic()
        outage = cfg.get('_room_list_outage')
        if outage is None:
            outage = cfg['_room_list_outage'] = {'started': now, 'last_log': now, 'failures': 1}
            # CLI exceptions can contain response bodies, URLs or credentials.
            log('room list failed, reading no room this tick', type(e).__name__)
        else:
            outage['failures'] += 1
            if now - outage['last_log'] >= ROOM_LIST_LOG_INTERVAL_S:
                log('room list still unavailable, reading no rooms',
                    f"failures={outage['failures']}", f"elapsed_s={int(now - outage['started'])}")
                outage['last_log'] = now
        cfg['_auto_dms'] = set()
        return []
    outage = cfg.pop('_room_list_outage', None)
    if outage is not None:
        log('room list recovered', f"failures={outage['failures']}",
            f"elapsed_s={int(time.monotonic() - outage['started'])}")
    listed = result['rooms']
    if result['total'] > cfg['max_rooms']:
        log('room list capped', result['total'], 'of', cfg['max_rooms'])
    rooms = [r['id'] for r in listed]
    cfg['_room_names'] = {r['id']: r['name'] for r in listed}
    terminal_event(cfg, 'rooms', count=len(rooms))
    dms = [r['id'] for r in listed if r['direct']]
    cfg['_last_id'] = {r['id']: r['latest'] for r in listed}
    cfg['_no_read'] = {r['id'] for r in listed if not r['read']}
    for room in result['joined']:
        state.pop(room, None)
    if result['joined'] or result['left']:
        log('rooms changed', 'joined', len(result['joined']), 'left', result['left'], 'now', len(rooms))
    state['_auto_rooms'], state['_auto_dms'] = rooms, dms
    cfg['_auto_dms'] = set(dms)
    save_json(cfg['state_file'], state)
    return rooms


def still_member(cfg, chat, room):
    """With "rooms": "auto", ask again right before a post: an answer can take a minute, and a room she was removed
    from meanwhile gets nothing. A failed query counts as not a member (fail closed: a missed reply)."""
    if cfg['rooms'] != 'auto':
        return True
    try:
        return room in {r.get('id') for r in chat.member_rooms()}
    except Exception as e:
        log('membership check failed', room, repr(e)[:200])
        return False


JOURNAL_COMMAND_OPS = ('journal_recall', 'journal_view', 'journal_receipt', 'journal_source', 'journal_commit')


def memory_op(cfg, room, op, *, failures=None, **payload):
    """Optional, killable memory I/O. Failure never changes delivery claims or retries a POST.

    Journal commands make several network source checks, so they get their own bounded time limit. When
    `failures` is a list, the failure class ('timeout' or 'worker_error') is appended to it."""
    if (not cfg.get('memory_instance') or
            room in set(cfg.get('dm_rooms', [])) | set(cfg.get('_auto_dms', []))):
        return None
    keys = ('cli', 'memory_instance', 'memory_timeout_s', 'recall_cap_chars',
            'history_n', 'message_cap_chars', 'self_session_id')
    process = None
    try:
        job = dict(config={k: cfg[k] for k in keys}, room=room, op=op, **payload)
        job['config']['journal_enabled'] = cfg.get('journal_enabled', False)
        directory = os.path.dirname(os.path.abspath(__file__))
        default_worker = 'agent_memory_worker.py'
        script = os.path.join(directory, cfg.get('memory_worker_name', default_worker))
        command = [sys.executable, '-I', '-B', script]
        if os.path.realpath(script) == os.path.realpath(os.path.join(directory, default_worker)):
            command = agent_journal.native_memory_command('automatic-worker')
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
    """One pass over every room. Returns the number of answers posted."""
    posted = 0
    for room in room_list(cfg, chat, state):
        if room in cfg.get('_no_read', ()):
            continue
        last = cfg.get('_last_id', {}).get(room)
        try:
            history = chat.read(room, cfg['history_n'])
        except Exception as e:
            log('read failed', room, repr(e)[:300])
            continue
        if isinstance(getattr(chat, 'time_zone', None), str):
            cfg['_time_zone'] = chat.time_zone
        if state.get(room, {}).get('since') is not None:
            settle_claims(chat, cfg, state, room)
        try:
            scan = poll_request('scan', room=state.get(room, {}), latest=last,
                                scope=wake_scope(cfg, room), history=history)
        except ValueError as error:
            log('room scan failed', room, type(error).__name__)
            continue
        if 'initial' in scan:
            state[room] = scan['initial']
            save_json(cfg['state_file'], state)
            terminal_event(cfg, 'note', text=f"Following {cfg.get('_room_names', {}).get(room, room)}; "
                           f"{len(history)} existing messages skipped.")
            continue
        seen = set()
        for index, wake in scan['pending']:
            msg = history[index]
            mid = msg['id']
            if mid in seen:
                continue
            if not wake:
                change_room(cfg, state, room, 'skip', id=mid)
                seen.add(mid)
                continue
            if posted >= cfg['max_answers_per_tick']:
                break
            if not alert_allows(cfg, chat, room, msg):
                change_room(cfg, state, room, 'complete', id=mid)
                seen.add(mid)
                continue
            change_room(cfg, state, room, 'claim', id=mid, msg_at=msg.get('at', 0))
            room_name = cfg.get('_room_names', {}).get(room, room)
            incoming_event(cfg, room_name, msg)
            try:
                timing = []
                if cfg.get('coding') and coding_chat.control_request(msg):
                    manager = cfg.get('_coding_manager')
                    reply = (manager.control(state, room, history, msg) if manager else
                             'Coding task refused: background task manager is not running.')
                    size = 0
                    searches = 0
                else:
                    if cfg.get('_coding_manager'):
                        cfg['_coding_manager'].before_chat()
                    recalled = memory_op(cfg, room, 'recall', query=(msg.get('text') or '')[:cfg['message_cap_chars']])
                    cfg['_admin_start_task'] = coding_chat.workspace_callback(cfg, cfg.get('_coding_manager'), state, room, history, msg)
                    try:
                        reply, size, searches = answer(cfg, room, history, msg, model, search, timing,
                                                       recalled=(recalled or {}).get('text', ''))
                    finally:
                        cfg.pop('_admin_start_task', None)
                if not reply:
                    raise RuntimeError('empty reply')
                member = still_member(cfg, chat, room)
                if member:
                    if not alert_allows(cfg, chat, room, msg):
                        change_room(cfg, state, room, 'complete', id=mid)
                        seen.add(mid)
                        continue
                    sent = reply[: cfg['reply_cap_chars']]
                    terminal_event(cfg, 'posting')
                    receipt = chat.say(room, sent, reply_to=mid)
            except Exception as e:
                log('answer failed', room, mid, repr(e)[:300])
                continue  # claim stays; settled or retried once on a later tick
            if not member:
                log('answer dropped: no longer a member', room, mid)
                # Known as left: if she is back on the next list, the room starts again from now.
                state['_auto_rooms'] = [r for r in state.get('_auto_rooms') or [] if r != room]
                change_room(cfg, state, room, 'complete', id=mid)
                break  # the rest of this room waits for the next tick's list
            change_room(cfg, state, room, 'complete', id=mid)
            seen.add(mid)
            posted += 1
            terminal_event(cfg, 'reply', room=room_name, text=sent,
                           confirmed=isinstance(receipt, dict) and bool(receipt.get('id')))
            if isinstance(receipt, dict) and receipt.get('id'):
                memory_op(cfg, room, 'record', event={'source': mid, 'at': msg.get('at'),
                          'text': (msg.get('text') or '')[:cfg['message_cap_chars']],
                          'reply': sent, 'reply_id': receipt['id']})
            log('answered', room, mid, f'request_chars={size}', f'reply_chars={len(reply)}', f'searches={searches}',
                'timing=' + timing_text(timing))
        else:
            # Every message up to `last` was handled (answered, skipped or left to a claim). Not after a break
            # (tick cap, removed room): those rooms are read again next tick.
            change_room(cfg, state, room, 'advance', latest=last)
    return posted


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
        if not view.inputs.empty() or wake.signal.is_set():
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
    view = DebugTerminal(cfg, interactive=False if '--no-tui' in argv or once else None).start()
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
