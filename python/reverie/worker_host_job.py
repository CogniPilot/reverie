"""Host-only allocation fencing inside the canonical resource admission domain.

An intent is not an authorization to execute a job. The fixed authenticated
actor must still authorize its request, and the installed native scope producer
must observe settlement. Lost processes/ACKs never reconstruct a live handle.
"""
import copy
from dataclasses import dataclass
import os
from pathlib import Path
import stat
import math
import time

from . import laptop_resource_operations as J
from . import host_job_scope as S
from .browser_job_policy import load_browser_job_policy
from .worker_resource_reservations import MIB, need, _file, _write_exclusive

NAME = 'host-job.intent.json'
FINISHING = 'host-job.finish.pending.json'


def _deadline(value):
    now = time.monotonic()
    need(value is None or type(value) in (int, float) and math.isfinite(value),
         'HOST_JOB_ADMISSION_DEADLINE')
    result = min(now + 30, value) if value is not None else now + 30
    need(now < result, 'HOST_JOB_ADMISSION_DEADLINE')
    return result


def _policy(gate, spec):
    policy = load_browser_job_policy(gate.broker.config)
    need(policy is not None, 'HOST_JOB_POLICY_REQUIRED')
    value = policy.document
    need(value['controlRoot'] == str(gate.root / 'host-jobs'), 'HOST_JOB_CONTROL_DOMAIN')
    limits, tools = value['limits'], value['tools']
    need(policy.sha256 == spec.policy_digest and limits['memoryBytes'] == spec.memory_bytes and
         limits['pids'] == spec.pids and tuple(limits['cpuSet']) == spec.cpus and
         limits['runtimeSeconds'] == spec.runtime_seconds and limits['stopSeconds'] == spec.stop_seconds and
         limits['hostReserveMiB'] == gate.option['hostReserveMiB'] and
         tools['systemctl'] == {'path': spec.systemctl, 'sha256': spec.systemctl_sha256} and
         tools['node'] == {'path': spec.node_exe, 'sha256': spec.node_sha256} and
         value['runner'] == {'path': spec.node_entry, 'sha256': spec.node_entry_sha256} and
         spec.working_directory == str(Path(value['controlRoot']) / 'tasks' /
             ('capture-' + spec.job_id) / 'f/work'), 'HOST_JOB_FIXED_POLICY_CHANGED')
    return policy


@dataclass(frozen=True, eq=False)
class _HostJobClaim:
    gate: object
    spec: object
    intent: object


def require_idle(gate):
    """No absent option, cold process or malformed file can grant credit."""
    directory = gate.root / 'operations'
    need(not os.path.lexists(directory / FINISHING), 'HOST_JOB_FINISH_REQUIRES_RECONCILIATION')
    if not os.path.lexists(directory / NAME):
        return
    value = _file(directory / NAME, gate.broker.config['uid'])
    need(type(value) is dict and set(value) == {'schema', 'state', 'scope', 'spec',
         'configurationDigest', 'settlementDigest'} and
         value['schema'] == 'reverie-host-job-intent-v1' and value['scope'] == gate.scope and
         value['configurationDigest'] == gate.binding['configurationDigest'] and
         value['state'] == 'SETTLED_NATIVE', 'HOST_JOB_OUTCOME_REQUIRES_PROTECTED_RECONCILIATION')
    spec = dict(value['spec']); spec['cpus'] = tuple(spec['cpus'])
    selected = S.FixedHostJobSpec(**spec).validate()
    receipt = _file(directory / ('host-job-settled-' + selected.job_id + '.json'), gate.broker.config['uid'])
    need(J.fingerprint(receipt) == value['settlementDigest'] and
         receipt['kind'] == 'OBSERVED_HOST_SCOPE_SETTLED' and receipt['spec'] == value['spec'],
         'HOST_JOB_SETTLEMENT_RECEIPT_CHANGED')


def begin(gate, spec, *, deadline=None):
    deadline = _deadline(deadline)
    need(type(spec) is S.FixedHostJobSpec, 'FIXED_HOST_JOB_SPEC_REQUIRED')
    spec.validate()
    with gate.admission(deadline=deadline):
        require_idle(gate)
        need(not os.path.lexists(gate.root / 'operations' / NAME), 'HOST_JOB_ALREADY_ATTEMPTED')
        policy = _policy(gate, spec)
        gate.native.custody(gate.root / 'host-jobs', policy.path)
        rows = gate._guard()
        _committed, budget, site, _bindings = gate.native.capacity(rows, gate.option)
        # The entire configured worker pool remains reserved. Neither a quiet
        # roster nor a stopped old resource operation creates host-job credit.
        host = gate.native.host_root()
        reserve = gate.option['hostReserveMiB'] * MIB
        need(budget + site['memory'] + reserve + spec.memory_bytes <= host['MemTotal'] and
             reserve + spec.memory_bytes <= host['MemAvailable'], 'HOST_JOB_CAPACITY_EXHAUSTED')
        gate._retained_delta(gate._document())
        need(gate.native.inventory() == rows, 'RESERVATION_NATIVE_INVENTORY_CHANGED')
        need(gate._guard() == rows, 'RESERVATION_NATIVE_INVENTORY_CHANGED')
        need(_policy(gate, spec) == policy, 'HOST_JOB_POLICY_CHANGED')
        intent = {'schema': 'reverie-host-job-intent-v1', 'state': 'INTENT_UNKNOWN_UNTIL_SETTLED',
                  'scope': copy.deepcopy(gate.scope), 'spec': spec.metadata(),
                  'configurationDigest': gate.binding['configurationDigest'], 'settlementDigest': None}
        # No effects may begin before this O_EXCL/fsync returns. A failure after
        # publication leaves a cold fence, even if no handle reaches the actor.
        _write_exclusive(gate.root / 'operations' / NAME, intent)
        handle = _HostJobClaim(gate, spec, intent)
        gate._host_jobs = {id(handle): {'handle': handle, 'binding': None}}
    return handle


def _current(gate, handle):
    need(type(handle) is _HostJobClaim and handle.gate is gate,
         'LIVE_HOST_JOB_HANDLE_REQUIRED')
    record = getattr(gate, '_host_jobs', {}).get(id(handle))
    need(record is not None and record['handle'] is handle, 'LIVE_HOST_JOB_HANDLE_REQUIRED')
    need(_file(gate.root / 'operations' / NAME, gate.broker.config['uid']) == handle.intent,
         'HOST_JOB_INTENT_CHANGED')
    return record


def bind(gate, handle, binding, *, deadline=None):
    deadline = _deadline(deadline)
    with gate.admission(deadline=deadline):
        record = _current(gate, handle)
        need(record['binding'] is None and type(binding) is S.OwnedScopeBinding and
             binding.spec == handle.spec, 'HOST_JOB_NATIVE_BINDING_REQUIRED')
        # The fixed native producer mints the binding; it cannot be restored
        # from the metadata copied into the durable evidence file.
        with S._REGISTRY_LOCK:
            registered = S._REGISTRY.get(id(binding))
            need(registered is not None and registered[0] is binding,
                 'HOST_JOB_NATIVE_BINDING_REQUIRED')
        _write_exclusive(gate.root / 'operations' / ('host-job-bound-' + handle.spec.job_id + '.json'),
                         binding.metadata())
        record['binding'] = binding


def finish(gate, handle, binding, *, deadline=None):
    deadline = _deadline(deadline)
    directory = gate.root / 'operations'
    pending = directory / FINISHING
    complete = None
    with gate.admission(deadline=deadline):
        record = _current(gate, handle)
        need(record['binding'] is binding, 'HOST_JOB_NATIVE_BINDING_REQUIRED')
        pending_value = {'schema': 'reverie-host-job-finish-v1', 'jobId': handle.spec.job_id,
                         'intentDigest': J.fingerprint(handle.intent)}
        _write_exclusive(pending, pending_value)
        settled = S.verify_settled(binding, deadline=deadline)
        need(type(settled) is S.ScopeSettlement and settled.spec == handle.spec and
             settled.invocation_id == binding.invocation_id and
             settled.control_group == binding.control_group, 'HOST_JOB_SETTLEMENT_UNKNOWN')
        _write_exclusive(gate.root / 'operations' / ('host-job-settled-' + handle.spec.job_id + '.json'),
                         settled.metadata())
        complete = {**handle.intent, 'state': 'SETTLED_NATIVE',
                    'settlementDigest': J.fingerprint(settled.metadata())}
        temporary = directory / ('host-job-complete-' + handle.spec.job_id + '.json')
        _write_exclusive(temporary, complete)
        gate._guard()
        # Re-observe the fixed actual scope after all filesystem/native work;
        # the returned JSON receipt is never an input to this verification.
        terminal = S.verify_settled(binding, deadline=deadline)
        need(terminal.spec == settled.spec and terminal.invocation_id == settled.invocation_id and
             terminal.control_group == settled.control_group and terminal.processes == settled.processes,
             'HOST_JOB_SETTLEMENT_CHANGED')
        _current(gate, handle)
        parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            held = os.fstat(parent)
            need([held.st_dev, held.st_ino] == gate.binding['directories']['operations'],
                 'RESERVATION_DIRECTORY_REBOUND')
            need(_file(temporary, gate.broker.config['uid']) == complete, 'HOST_JOB_COMPLETION_CHANGED')
            os.replace(temporary.name, NAME, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(parent)
        # The separate pending fence survives every remaining context/fd
        # finalizer and the admission's last native custody observation.
    need(_file(directory / NAME, gate.broker.config['uid']) == complete and
         _file(pending, gate.broker.config['uid']) == pending_value, 'HOST_JOB_COMPLETION_CHANGED')
    physical = directory.lstat()
    need(stat.S_ISDIR(physical.st_mode) and [physical.st_dev, physical.st_ino] ==
         gate.binding['directories']['operations'], 'RESERVATION_DIRECTORY_REBOUND')
    need(time.monotonic() < deadline, 'HOST_JOB_ADMISSION_DEADLINE')
    # Last fallible operation. No directory fsync/descriptor cleanup follows;
    # power loss can resurrect a conservative reconciliation fence. New job
    # execution is still one-shot, even after this actual settlement.
    os.unlink(pending)
    record['settled'] = True
    return {'state': 'NATIVE_SETTLED', 'allocationFenced': False, 'jobId': handle.spec.job_id}
