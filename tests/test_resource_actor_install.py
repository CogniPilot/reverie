"""Real private stores/flocks/publication; engine/program ports controlled.

These controls never install a unit, connect to an engine, launch a process,
mint owner authority, resize a laptop or claim native acceptance.
"""
import copy
from contextlib import contextmanager
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from reverie import resource_actor_install as I
from reverie import worker_resource_reservations as R
from reverie.owner_terminal_channel import Program
from tests import test_worker_resource_reservations as F


def model_nix_fixture_ancestry(test):
    """Only the fixed namespace roots are a controlled host-metadata port.

    Nix exposes / and /tmp as uid 65534 here. These store/fault tests do not
    attest native host ownership. Keep every actual private path, inode,
    permission, symlink and replacement observation unchanged.
    """
    if not os.environ.get('NIX_BUILD_TOP'):
        return
    original = Path.lstat
    mapped_root = Path('/').stat().st_uid
    roots = {Path('/'), Path('/tmp')}
    def lstat(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        if path in roots and info.st_uid == mapped_root:
            values = list(info); values[4] = 0
            return os.stat_result(values)
        return info
    test.enterContext(patch.object(Path, 'lstat', lstat))


class InactivePublicationTests(unittest.TestCase):
    def setUp(self):
        provision = R.provision
        def selected(broker):
            broker.config['resourceActorConfig'] = str(Path(broker.config['resourceReservations']['directory'])/'resource-actor.json')
            return provision(broker)
        with patch.object(R, 'provision', side_effect=selected):
            self.f = F.Reservations(); self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        f = self.f; self.path = Path(f.config['resourceActorConfig'])
        f.native.rows[1]['Image'] = 'sha256:'+'c'*64
        self.item = copy.deepcopy(f.native.rows[1]); self.item['Config']['User'] = str(os.getuid())+':'+str(os.getgid())
        self.item['HostConfig']['OomKillDisable'] = False
        self.provenance_path = f.control/'synthetic-provenance.json'; self.provenance_path.write_text('owned input port')
        self.client = Program('/nix/store/synthetic-python/bin/python3.13',
                              ('/nix/store/synthetic-python/bin/python3', '-I', '-B', '/nix/store/synthetic-source/worker.py', 'client'))
        self.prefix = ['/nix/store/synthetic-node/bin/node', '/nix/store/synthetic-console/lib/reverie/dist/index.js']
        self.provenance = {'clientManifest': {'path': '/nix/store/synthetic-client/manifest.json', 'sha256': 'a'*64},
                           'node': {'executable': self.prefix[0], 'argvPrefix': self.prefix},
                           'codeFiles': {self.prefix[0]: {'sha256': 'b'*64, 'bytes': 1}}}
        self.on_qualify = lambda: None
        owner = self
        class Engine:
            def __init__(self, path, identity, engine_id):
                self.path, self.identity, self.engine_id = path, identity, engine_id
            def guard(self): pass
            def get(self, route):
                if route == '/info': return {'ID': 'synthetic-engine'}
                if route.startswith('/containers/'): return copy.deepcopy(owner.item)
                if route.startswith('/images/'): return {'Id': owner.item['Image']}
                raise AssertionError('No other engine operation is allowed')
        class Facts:
            KEYS = I.WebsiteFacts.KEYS
            def __init__(self, engine, selection): self.engine, self.selection = engine, copy.deepcopy(selection)
            def bind_once(self): self.binding = copy.deepcopy(self.selection); return self.binding
            def inspect(self): return copy.deepcopy(owner.item)
            def qualify_code(self): owner.on_qualify()
        class Peer:
            def __init__(self, facts): self.facts = facts
            def assert_process(self, credentials, stage):
                assert credentials == (987, os.getuid(), os.getgid()) and stage == 'node'
        patches = [patch.object(I, 'immutable', return_value=self.provenance_path),
                   patch.object(I, 'artifact', return_value=self.provenance), patch.object(I, '_client', return_value=self.client),
                   patch.object(I, 'socket_identity', return_value=(1, 2, 0, 0)), patch.object(I, 'Engine', Engine),
                   patch.object(I, 'WebsiteFacts', Facts), patch.object(I, 'ProtectedPeer', Peer),
                   patch.object(I, 'read_proc', return_value={'pid': 124, 'start': 77, 'namespaces': (1, 2, 3)}),
                   patch.object(I, '_node_argv', return_value=(987, self.prefix)),
                   patch.object(I, 'verify_image_spec', side_effect=lambda _p, actual: actual['Id'])]
        for p in patches: p.start(); self.addCleanup(p.stop)
        model_nix_fixture_ancestry(self)

    def prepare(self):
        return I.prepare(self.f.native, self.provenance_path, '/synthetic/engine.sock', 'synthetic-engine')

    def test_engine_must_match_the_actual_broker_preflight_identity(self):
        with self.assertRaisesRegex(ValueError,'BROKER_ENGINE_CHANGED'):
            I.prepare(self.f.native,self.provenance_path,'/synthetic/engine.sock','different-selected-engine')
        self.assertFalse(self.path.exists())

    def test_explicit_prepare_publishes_private_v2_facts_without_owner_or_runtime_effect(self):
        self.assertFalse(self.path.exists())
        self.assertEqual(self.prepare(), {'prepared': True, 'changed': True, 'started': False})
        raw = self.path.read_bytes(); value = json.loads(raw)
        self.assertEqual(value['version'], 2); self.assertNotIn('ownerApproved', value)
        self.assertEqual(value['client'], self.provenance['clientManifest'])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.prepare(), {'prepared': True, 'changed': False, 'started': False})
        self.assertEqual(self.path.read_bytes(), raw)
        self.assertFalse((self.f.control/'resource-actor.installing.json').exists())
        self.assertTrue(all(args[0] in ('ps', 'inspect') for args in self.f.native.calls))

    def test_live_or_stale_transport_is_not_deleted_or_adopted(self):
        socket = Path(self.f.config['socket']); socket.parent.mkdir(parents=True, exist_ok=True); socket.write_text('retained owner evidence')
        with self.assertRaisesRegex(ValueError, 'SOCKET_MUST_BE_ABSENT'): self.prepare()
        self.assertEqual(socket.read_text(), 'retained owner evidence'); self.assertFalse(self.path.exists())

    def test_real_active_journal_claim_refuses_before_fact_publication(self):
        claim = self.f.claim()
        with self.f.gate.admission():
            self.assertIn(claim['operation']['id'], self.f.gate._document()['operations'])
        with self.assertRaisesRegex(ValueError, 'ACTIVE_OPERATION'): self.prepare()
        self.assertFalse(self.path.exists())

    def test_concurrent_private_record_change_is_preserved_and_never_replaced(self):
        self.prepare(); original = json.loads(self.path.read_text())
        changed = {**original, 'configurationDigest': 'd'*64}
        def owner_change(): self.path.write_text(json.dumps(changed))
        self.on_qualify = owner_change
        with patch.object(I, '_node_argv', return_value=(987, self.prefix+['--port', '3001'])):
            with self.assertRaisesRegex(ValueError, 'CURRENT_RECORD_CHANGED'): self.prepare()
        self.assertEqual(json.loads(self.path.read_text()), changed)
        self.assertTrue((self.f.control/'resource-actor.installing.json').exists())
        self.assertEqual(len(list(self.f.control.glob('resource-actor.previous.*.json'))), 1)

    def test_failed_postpublication_check_is_retained_and_not_reported_as_prepared(self):
        with patch.object(I, '_BoundFacts', side_effect=ValueError('controlled postpublication native refusal')):
            with self.assertRaisesRegex(ValueError, 'postpublication'): self.prepare()
        self.assertTrue(self.path.is_file())
        self.assertEqual(json.loads(self.path.read_text())['version'], 2)
        self.assertTrue((self.f.control/'resource-actor.installing.json').is_file())
        with self.assertRaisesRegex(ValueError,'PENDING_REQUIRES_INSPECTION'):
            I.InstalledFacts(self.f.native,R.ReservationGate(self.f.native))

    def test_retained_valid_marker_blocks_idempotent_prepare_and_runtime_use(self):
        self.prepare(); gate=R.ReservationGate(self.f.native)
        installed=I.InstalledFacts(self.f.native,gate)
        marker=self.f.control/'resource-actor.installing.json'
        marker.write_bytes(self.path.read_bytes());marker.chmod(0o600)
        for operation in [self.prepare,lambda:I.InstalledFacts(self.f.native,gate),installed.guard]:
            with self.assertRaisesRegex(ValueError,'PENDING_REQUIRES_INSPECTION'):operation()
        self.assertTrue(marker.is_file())

    def test_last_directory_sync_failure_keeps_published_facts_fenced(self):
        original=I._sync_root; calls=0
        def fail_last(root):
            nonlocal calls
            calls+=1
            if calls==3: raise OSError('controlled final durability failure')
            return original(root)
        with patch.object(I,'_sync_root',side_effect=fail_last):
            with self.assertRaisesRegex(OSError,'final durability'): self.prepare()
        self.assertEqual(calls,3)
        self.assertTrue(self.path.is_file())
        self.assertTrue(self.path.with_name('resource-actor.installing.json').is_file())

    def test_admission_exit_failure_keeps_published_facts_fenced(self):
        original=R.ReservationGate.admission
        @contextmanager
        def fail_exit(gate):
            with original(gate): yield
            raise OSError('controlled admission finalizer failure')
        with patch.object(R.ReservationGate,'admission',fail_exit):
            with self.assertRaisesRegex(OSError,'admission finalizer'): self.prepare()
        self.assertTrue(self.path.is_file())
        self.assertTrue(self.path.with_name('resource-actor.installing.json').is_file())

    def test_registered_refresh_preserves_transport_and_finalizes_before_fence_release(self):
        from reverie.resource_actor_refresh import RegisteredTransport
        transport=object.__new__(RegisteredTransport);transport.config=self.f.config
        calls=[]
        transport.guard=lambda:calls.append('guard')
        def finalize():
            self.assertTrue(self.path.with_name('resource-actor.installing.json').is_file())
            calls.append('finalized')
        transport.finalize=finalize
        path=Path(self.f.config['socket']);path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text('owned controlled transport port')
        result=I.prepare(self.f.native,self.provenance_path,'/synthetic/engine.sock',
                         'synthetic-engine',transport=transport)
        self.assertEqual(result,{'prepared':True,'changed':True,'started':False})
        self.assertEqual(calls[-1],'finalized');self.assertGreaterEqual(calls.count('guard'),4)
        self.assertEqual(path.read_text(),'owned controlled transport port')
        self.assertFalse(self.path.with_name('resource-actor.installing.json').exists())

    def test_failed_registered_peer_finalizer_keeps_new_facts_fenced(self):
        from reverie.resource_actor_refresh import RegisteredTransport
        transport=object.__new__(RegisteredTransport);transport.config=self.f.config
        transport.guard=lambda:None
        def fail():raise OSError('controlled registered-peer close failure')
        transport.finalize=fail
        with self.assertRaisesRegex(OSError,'registered-peer close'):
            I.prepare(self.f.native,self.provenance_path,'/synthetic/engine.sock',
                      'synthetic-engine',transport=transport)
        self.assertTrue(self.path.is_file())
        self.assertTrue(self.path.with_name('resource-actor.installing.json').is_file())

    def test_late_owner_file_change_is_preserved_and_does_not_release_pending_fence(self):
        from reverie.resource_actor_refresh import RegisteredTransport
        for selected in ('current','pending'):
            with self.subTest(selected=selected):
                # A separate private admission fixture for each finalizer race.
                other=InactivePublicationTests();other.setUp()
                try:
                    transport=object.__new__(RegisteredTransport);transport.config=other.f.config
                    transport.guard=lambda:None
                    marker=other.path.with_name('resource-actor.installing.json')
                    changed=other.path if selected=='current' else marker
                    transport.finalize=lambda:changed.write_bytes(b'owner changed evidence')
                    with self.assertRaisesRegex(ValueError,'PUBLISHED_RECORD_CHANGED|PENDING_CHANGED'):
                        I.prepare(other.f.native,other.provenance_path,'/synthetic/engine.sock',
                                  'synthetic-engine',transport=transport)
                    self.assertTrue(marker.is_file())
                    self.assertEqual(changed.read_bytes(),b'owner changed evidence')
                finally:other.doCleanups()

    def test_last_marker_reader_cannot_hide_a_current_record_change(self):
        from reverie.resource_actor_refresh import RegisteredTransport
        transport=object.__new__(RegisteredTransport);transport.config=self.f.config
        transport.guard=lambda:None
        finalized=False;changed=False;marker=self.path.with_name('resource-actor.installing.json')
        def close():
            nonlocal finalized
            finalized=True
        transport.finalize=close
        read=I.private_entry
        def mutate(path,*args,**kwargs):
            nonlocal changed
            result=read(path,*args,**kwargs)
            if finalized and Path(path)==marker and not changed:
                changed=True;self.path.write_bytes(b'owner changed after final record read')
            return result
        with patch.object(I,'private_entry',side_effect=mutate):
            with self.assertRaisesRegex(ValueError,'TERMINAL_ENTRY_CHANGED'):
                I.prepare(self.f.native,self.provenance_path,'/synthetic/engine.sock',
                          'synthetic-engine',transport=transport)
        self.assertTrue(changed);self.assertTrue(marker.is_file())
        self.assertEqual(self.path.read_bytes(),b'owner changed after final record read')

    def test_idempotent_prepare_finishes_admission_before_final_record_read(self):
        self.prepare();original=R.ReservationGate.admission
        @contextmanager
        def change_on_exit(gate):
            with original(gate):yield
            self.path.write_bytes(b'owner changed during final admission cleanup')
        with patch.object(R.ReservationGate,'admission',change_on_exit):
            with self.assertRaisesRegex(ValueError,'PUBLISHED_RECORD_CHANGED'):
                self.prepare()
        self.assertEqual(self.path.read_bytes(),b'owner changed during final admission cleanup')


if __name__ == '__main__': unittest.main()
