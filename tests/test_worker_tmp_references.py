"""Reference observations for the explicit non-destructive retention strategy."""
import os
import socket
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from reverie import worker_tmp_references as refs
from reverie.worker_cold_tmp import read_mount_table, _mount_id


class ReferenceObservations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.target = self.base / 'tmp'
        self.target.mkdir(mode=0o700)
        self.file = self.target / 'held'
        self.file.write_bytes(b'owned-marker')
        self.proc = self.base / 'proc'
        self.proc.mkdir()
        self.table = read_mount_table()
        fd = os.open(self.file, os.O_PATH)
        try:
            self.mount_id = _mount_id(fd)
        finally:
            os.close(fd)

    def process(self, pid, *, held=False):
        root = self.proc / str(pid)
        root.mkdir()
        (root / 'fd').mkdir()
        (root / 'fdinfo').mkdir()
        (root / 'status').write_text('Uid:\t' + '\t'.join([str(os.getuid())] * 4) + '\n')
        (root / 'stat').write_text(str(pid) + ' (owned fixture) ' + ' '.join(['S'] + ['0'] * 18 + ['42']))
        (root / 'maps').write_text('')
        (root / 'net').mkdir(); (root / 'net/unix').write_text('Num RefCount Protocol Flags Type St Inode Path\n')
        if held:
            (root / 'fd/0').symlink_to(self.file)
            (root / 'fdinfo/0').write_text('mnt_id:\t' + str(self.mount_id) + '\nino:\t' + str(self.file.stat().st_ino) + '\n')
        for kind in ('cwd', 'root', 'exe'):
            (root / kind).symlink_to(self.base)
        return root

    def collect(self):
        return refs.collect(self.target, proc=self.proc, table_reader=lambda *_: self.table)

    def test_unknown_first_does_not_hide_later_actual_holder(self):
        hidden = self.process(10, held=True)
        self.process(20, held=True)
        original_stat, original_link = Path.stat, os.readlink
        def hidden_stat(path, *args, **kwargs):
            if path == hidden / 'fd/0':
                raise PermissionError(13, 'owned control')
            return original_stat(path, *args, **kwargs)
        def hidden_link(path, *args, **kwargs):
            if Path(path) == hidden / 'fd/0':
                raise PermissionError(13, 'owned control')
            return original_link(path, *args, **kwargs)
        with patch.object(Path, 'stat', hidden_stat), patch('os.readlink', hidden_link):
            result = self.collect()
        self.assertGreater(result['counts']['unknown'], 0)
        self.assertIn({'pid': 20, 'kind': 'FD_REFERENCE'}, result['knownReferences'])
        self.assertFalse(result['absenceOfReferencesProven'])

    def test_real_host_fd_is_known_in_controlled_process_inventory(self):
        fd = os.open(self.file, os.O_RDONLY)
        listdir = os.listdir
        def inventory(path):
            return [str(os.getpid())] if Path(path) == Path('/proc') else listdir(path)
        try:
            with patch('os.listdir', inventory):
                result = refs.collect(self.target)
            self.assertTrue(any(x['pid'] == os.getpid() and x['kind'] == 'FD_REFERENCE'
                                for x in result['knownReferences']))
        finally:
            os.close(fd)

    def test_detached_mount_unknown_does_not_hide_later_known_holder(self):
        root = self.process(10, held=True)
        self.process(20, held=True)
        absent_id = max(row['id'] for row in self.table) + 1
        (root / 'fdinfo/0').write_text('mnt_id: ' + str(absent_id) + '\nino: 1\n')
        result = self.collect()
        self.assertIn({'pid': 10, 'kind': 'FD_MOUNT_NOT_IN_CURRENT_NAMESPACE'}, result['unknownReferences'])
        self.assertIn({'pid': 20, 'kind': 'FD_REFERENCE'}, result['knownReferences'])
        self.assertFalse(result['absenceOfReferencesProven'])

    def test_duplicate_mount_identity_still_refuses(self):
        self.process(20, held=True)
        original = next(row for row in self.table if row['id'] == self.mount_id)
        with self.assertRaisesRegex(RuntimeError, 'coordinates are ambiguous'):
            refs.collect(self.target, proc=self.proc,
                         table_reader=lambda pid=None: self.table if pid is None else self.table + [original])

    def test_empty_namespace_coordinates_remain_unknown_before_known_holder(self):
        self.process(10, held=True)
        self.process(20, held=True)
        result = refs.collect(self.target, proc=self.proc,
                              table_reader=lambda pid=None: [] if pid == 10 else self.table)
        self.assertIn({'pid': 10, 'kind': 'REFERENCE_COORDINATES_UNAVAILABLE'}, result['unknownReferences'])
        self.assertIn({'pid': 20, 'kind': 'FD_REFERENCE'}, result['knownReferences'])
        self.assertFalse(result['absenceOfReferencesProven'])

    def test_real_owned_unix_listener_inside_tmp_is_known(self):
        path = self.target / 'owned.sock'
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(path))
            listener.listen(1)
            result = refs.collect(self.target)
            self.assertGreater(result['counts']['known'],0)
            self.assertTrue(any(x['kind'] in ('SOCKET_REFERENCE','UNIX_SOCKET_REFERENCE_IN_NAMESPACE')
                                for x in result['knownReferences']))

    def test_kernel_unix_path_remains_known_when_fd_identity_is_hidden(self):
        root=self.process(10,held=True)
        (root/'net/unix').write_text('Num RefCount Protocol Flags Type St Inode Path\n' +
            '00000000: 00000002 00000000 00010000 0001 01 1234 '+str(self.file)+'\n')
        original_stat=Path.stat
        def hidden(path,*a,**kw):
            if path == root/'fd/0':raise PermissionError(13,'owned hidden FD')
            return original_stat(path,*a,**kw)
        with patch.object(Path,'stat',hidden):result=self.collect()
        self.assertIn({'observerPid':10,'kind':'UNIX_SOCKET_REFERENCE_IN_NAMESPACE'},result['knownReferences'])
        self.assertGreater(result['counts']['unknown'],0)

    def test_cwd_reference_is_known(self):
        root = self.process(20)
        (root / 'cwd').unlink()
        (root / 'cwd').symlink_to(self.target)
        self.assertIn({'pid': 20, 'kind': 'CWD_REFERENCE'}, self.collect()['knownReferences'])

    def test_sparse_large_old_tree_is_not_walked_or_read(self):
        self.process(20)
        large = self.target / 'sparse'
        with large.open('wb') as stream:
            stream.truncate(3 << 30)
        for i in range(4100):
            (self.target / str(i)).touch()
        with patch('os.scandir', side_effect=AssertionError('old tree must not be walked')):
            result = self.collect()
        self.assertFalse(result['treeWalkPerformed'])
        self.assertEqual(result['counts']['known'], 0)
        self.assertEqual(large.stat().st_size, 3 << 30)

    def test_large_epoll_fdinfo_reads_only_identity_header(self):
        root = self.process(20, held=True)
        path = root / 'fdinfo/0'
        path.write_text('pos: 0\nflags: 0100000\nmnt_id: ' + str(self.mount_id) +
                        '\nino: 1\n' + 'tfd: 999999 event metadata\n' * 10000)
        self.assertIn({'pid': 20, 'kind': 'FD_REFERENCE'}, self.collect()['knownReferences'])

    def test_fd_bound_refuses_instead_of_hiding_unvisited_holder(self):
        self.process(10)
        self.process(20, held=True)
        with patch.object(refs, 'MAX_FDS_TOTAL', 0):
            with self.assertRaisesRegex(RuntimeError, 'FD inventory bound'):
                self.collect()

    def test_mount_inventory_bound_is_not_permission_unknown(self):
        self.process(10)
        def bounded(pid=None):
            if pid == 10:
                raise RuntimeError('Mount namespace inventory exceeds bound')
            return self.table
        with self.assertRaisesRegex(RuntimeError, 'inventory exceeds bound'):
            refs.collect(self.target, proc=self.proc, table_reader=bounded)

    def test_unavailable_mounts_do_not_hide_later_holder(self):
        self.process(10, held=True)
        self.process(20, held=True)
        def unavailable(pid=None):
            if pid == 10:
                raise PermissionError(13, 'owned namespace permission gap')
            return self.table
        result=refs.collect(self.target, proc=self.proc, table_reader=unavailable)
        self.assertIn({'pid':20,'kind':'FD_REFERENCE'}, result['knownReferences'])
        self.assertGreater(result['counts']['unknown'],0)

    def test_pid_identity_drift_refuses(self):
        root = self.process(20)
        original = refs._pid_identity
        calls = 0
        def drift(base):
            nonlocal calls
            result = original(base)
            if base == root:
                calls += 1
                return result if calls == 1 else ('S', '43')
            return result
        with patch.object(refs, '_pid_identity', drift):
            with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                self.collect()

    def test_exited_same_binding_zombie_is_not_live_reference_unknown(self):
        root=self.process(20)
        (root/'maps').unlink()
        original=refs._pid_identity;calls=0
        def exited(base):
            nonlocal calls
            current=original(base)
            if base==root:
                calls+=1
                if calls>1:return ('Z',current[1])
            return current
        with patch.object(refs,'_pid_identity',exited):result=self.collect()
        self.assertEqual(result['counts']['known'],0)

    def test_malformed_credentials_are_not_permission_unknown(self):
        root = self.process(20)
        (root / 'status').write_text('Uid:\tbroken\n')
        with self.assertRaisesRegex(RuntimeError, 'credentials unavailable'):
            self.collect()
