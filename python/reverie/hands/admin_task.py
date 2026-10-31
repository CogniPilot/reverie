"""Natural chat entry to the existing authorized, bounded workspace task manager."""
import json
import re
from coding_tasks import permitted_sender

TOOL_NAME = 'run_workspace_task'
TOOL = {'type': 'function', 'function': {
    'name': TOOL_NAME,
    'description': 'Actually start the requested coding or office CLI work on your own laptop. Use this for file edits, tests or reverie Board commands instead of promising to run them. The bounded background task reports actual tool/test receipts to the room. This does not grant any new permission.',
    'parameters': {'type': 'object', 'properties': {'brief': {'type': 'string', 'description': 'A concise execution plan for the current authorized request. Preserve the original request and verify results.'}}, 'required': ['brief'], 'additionalProperties': False}}}
CANCEL_TOOL_NAME = 'cancel_workspace_task'
CANCEL_TOOL = {'type': 'function', 'function': {
    'name': CANCEL_TOOL_NAME,
    'description': 'Stop the workspace task that is running now on your own laptop. Use this when you are asked to stop, '
                   'cancel or abort the current work. Starting another task never stops one.',
    'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False}}}
TOOLS = [TOOL, CANCEL_TOOL]
RULE = ('You are the Reverie Admin Harness. For an action request, use run_workspace_task to start real work; '
        'a plain chat answer does not run commands. Never say you edited, tested or filed something unless a tool receipt confirms it. '
        'To stop, cancel or abort the running work, use cancel_workspace_task; never start a new task to stop one. '
        'A queued task is not completion. For current permissions use reverie agent capabilities; file decision requests with reverie board decision add, not an imagined coordinator-only queue.')
# For a message that did not address this harness only the cancel tool is offered, so the rule never names the start tool.
CANCEL_RULE = ('You are the Reverie Admin Harness. This message did not ask you directly, so you cannot start work from it: '
               'answer in chat, and to have work started the person must mention you or reply to you. '
               'Never say you edited, tested or filed something unless a tool receipt confirms it. '
               'To stop, cancel or abort the running work, use cancel_workspace_task.')

def rule(tools):
    """The rule for the tools actually offered: it may name the start tool only when that tool is offered."""
    return RULE if any((tool.get('function') or {}).get('name') == TOOL_NAME for tool in tools) else CANCEL_RULE

def validate(cfg):
    name = cfg.get('admin_task')
    if name is None:return
    if not isinstance(name, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', name):
        raise ValueError('admin_task must name an explicitly configured coding task')
    task = (cfg.get('coding') or {}).get('tasks', {}).get(name)
    if not isinstance(task, dict):
        raise ValueError('admin_task must exist in the configured coding task map')

def addressed(cfg, room, history, message):
    """Only a message meant for this harness may start work: one in a direct-message room, one sent to it, a reply to
    its own message, or an @name mention. A room-wide @everyone, or a reply to someone else, is conversation."""
    self_id = cfg.get('self_session_id')
    if room in cfg.get('dm_rooms', []) or room in cfg.get('_auto_dms', ()):
        return True
    if self_id and isinstance(message.get('to'), list) and self_id in message['to']:
        return True
    original = next((item for item in history if item.get('id') == message.get('replyTo') and not item.get('deleted')), {})
    if self_id and (original.get('from') or {}).get('sessionId') == self_id:
        return True
    name = cfg.get('self_name')
    return (isinstance(name, str) and bool(name) and
            re.search(r'(?<![\w@])@' + re.escape(name) + r'(?![\w-])', message.get('text') or '', re.I) is not None)

def callback(cfg, manager, state, room, history, message):
    name = cfg.get('admin_task')
    settings = cfg.get('coding')
    if not name or manager is None or not settings or not permitted_sender(settings, room, name, message):
        return None
    if settings['tasks'][name].get('enabled', True) is not True:return None
    # A bound sender's ordinary chat (a game turn, a reply to someone else) may still stop work, never start it.
    may_start = addressed(cfg, room, history, message)
    def start(brief):
        if not may_start:
            return 'Workspace task not started: the message did not address me. Mention me or reply to me to ask for work.'
        if not isinstance(brief, str) or not brief.strip() or len(brief) > 6000:
            return 'Workspace task refused: provide a short nonempty execution plan.'
        original = message.get('text') or ''
        text = ('/code '+name+' Original authorized request (verbatim):\n'+original+
                '\nExecution plan (model suggestion, not extra authority):\n'+brief)
        # Preserve the actual authenticated sender, room and source message ID.
        # TaskManager rechecks authorization, current settings, membership, limits and its durable journal.
        return manager.control(state, room, history, {**message, 'text': text}, canonical_source=message)
    def cancel():
        # Names only this harness's task. TaskManager rechecks the sender and room, and stops only a task that is running.
        return manager.control(state, room, history, {**message, 'text': '/code-cancel '+name})
    start.cancel = cancel
    start.tools = TOOLS if may_start else [CANCEL_TOOL]
    return start

def invoke(output, start):
    calls = output.get('tool_calls') or []
    selected = [call for call in calls if isinstance(call, dict) and isinstance(call.get('function'), dict) and call['function'].get('name') in (TOOL_NAME, CANCEL_TOOL_NAME)]
    if not selected:return None
    if start is None:return 'Workspace task refused: this message has no authorized task/room/sender binding.'
    if len(calls) != 1 or len(selected) != 1:return 'Workspace task refused: request one workspace task at a time.'
    call = selected[0]
    try:
        if call.get('type') != 'function' or not isinstance(call.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', call['id']):raise ValueError()
        raw = call['function'].get('arguments')
        if not isinstance(raw, str) or len(raw) > 8192:raise ValueError()
        args = json.loads(raw)
        cancelling = call['function']['name'] == CANCEL_TOOL_NAME
        if not isinstance(args, dict) or set(args) != (set() if cancelling else {'brief'}):raise ValueError()
    except (ValueError, TypeError):
        return 'Workspace task refused: invalid structured tool arguments. No command ran.'
    return start.cancel() if cancelling else start(args['brief'])
