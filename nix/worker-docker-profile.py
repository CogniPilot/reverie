"""Keep Docker default denials while permitting rootless namespace construction."""
import json
from pathlib import Path
import sys

NAMESPACE_CALLS = ('clone', 'unshare', 'setns', 'mount', 'umount2', 'pivot_root',
                   'open_tree', 'move_mount', 'fsopen', 'fsconfig', 'fsmount', 'fspick',
                   'mount_setattr', 'sethostname', 'setdomainname', 'mknod', 'mknodat')


def profile(source):
    value = json.loads(source)
    if value['defaultAction'] != 'SCMP_ACT_ERRNO':
        raise ValueError('Default-deny upstream profile required')
    # No keyctl, bpf, perf or general syscall relaxation. Kernel ownership/capability
    # checks still restrict these calls to the unprivileged user's namespaces.
    value['syscalls'].append({'names': list(NAMESPACE_CALLS), 'action': 'SCMP_ACT_ALLOW'})
    return value


if __name__ == '__main__':
    Path(sys.argv[2]).write_text(json.dumps(profile(Path(sys.argv[1]).read_text()), sort_keys=True) + '\n')
