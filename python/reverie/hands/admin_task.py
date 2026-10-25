"""Natural chat entry to the existing authorized, bounded workspace task manager."""
import json
import re
from coding_tasks import permitted_sender

TOOL_NAME = 'run_workspace_task'
TOOL = {'type': 'function', 'function': {
    'name': TOOL_NAME,
    'description': 'Actually start the requested coding or office CLI work on your own laptop. Use this for file edits, tests or reverie Board commands instead of promising to run them. The bounded background task reports actual tool/test receipts to the room. This does not grant any new permission.',
    'parameters': {'type': 'object', 'properties': {'brief': {'type': 'string', 'description': 'A concise execution plan for the current authorized request. Preserve the original request and verify results.'}}, 'required': ['brief'], 'additionalProperties': False}}}
RULE = ('You are the Reverie Admin Harness. For an action request, use run_workspace_task to start real work; '
        'a plain chat answer does not run commands. Never say you edited, tested or filed something unless a tool receipt confirms it. '
        'A queued task is not completion. For current permissions use reverie agent capabilities; file decision requests with reverie board decision add, not an imagined Burt-only queue.')

def validate(cfg):
    name = cfg.get('admin_task')
    if name is None:return
    if not isinstance(name, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', name):
        raise ValueError('admin_task must name an explicitly configured coding task')
    task = (cfg.get('coding') or {}).get('tasks', {}).get(name)
    if not isinstance(task, dict):
        raise ValueError('admin_task must exist in the configured coding task map')

def callback(cfg, manager, state, room, history, message):
    name = cfg.get('admin_task')
    settings = cfg.get('coding')
    if not name or manager is None or not settings or not permitted_sender(settings, room, name, message):
        return None
    if settings['tasks'][name].get('enabled', True) is not True:return None
    def start(brief):
        if not isinstance(brief, str) or not brief.strip() or len(brief) > 6000:
            return 'Workspace task refused: provide a short nonempty execution plan.'
        original = message.get('text') or ''
        text = ('/code '+name+' Original authorized request (verbatim):\n'+original+
                '\nExecution plan (model suggestion, not extra authority):\n'+brief)
        # Preserve the actual authenticated sender, room and source message ID.
        # TaskManager rechecks authorization, current settings, membership, limits and its durable journal.
        return manager.control(state, room, history, {**message, 'text': text})
    return start

def invoke(output, start):
    calls = output.get('tool_calls') or []
    selected = [call for call in calls if isinstance(call, dict) and isinstance(call.get('function'), dict) and call['function'].get('name') == TOOL_NAME]
    if not selected:return None
    if start is None:return 'Workspace task refused: this message has no authorized task/room/sender binding.'
    if len(calls) != 1 or len(selected) != 1:return 'Workspace task refused: request one workspace task at a time.'
    call = selected[0]
    try:
        if call.get('type') != 'function' or not isinstance(call.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', call['id']):raise ValueError()
        raw = call['function'].get('arguments')
        if not isinstance(raw, str) or len(raw) > 8192:raise ValueError()
        args = json.loads(raw)
        if not isinstance(args, dict) or set(args) != {'brief'}:raise ValueError()
    except (ValueError, TypeError):
        return 'Workspace task refused: invalid structured tool arguments. No command ran.'
    return start(args['brief'])
