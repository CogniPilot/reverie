"""Real artifact decoding/producer contract with controlled immutable-file ports.

No native installation, engine, service or employee action is performed. The
separate synthetic installed acceptance exercises those real boundaries.
"""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reverie import owner_terminal_toolkit as T
from reverie import owner_terminal_lifecycle as L
from tests import test_owner_terminal_lifecycle as lifecycle_fixture

MANIFEST='/nix/store/synthetic-toolkit/manifest.json'
VALUE={'version':1,'static':True,'files':{name:{'sha256':'0'*64,'bytes':4} for name in T.FILES}}
RAW=json.dumps(VALUE,sort_keys=True).encode()
PAIR={'path':MANIFEST,'sha256':hashlib.sha256(RAW).hexdigest()}


@contextmanager
def immutable_ports(raw=RAW, *, rebound=False):
    """Only one immutable-file boundary is controlled; other owned FDs are real."""
    original_open,original_read,original_stat,original_close=os.open,os.read,os.fstat,os.close
    resolve=Path.resolve;fake_fd=1<<29
    def opened(path,flags,*args,**kwargs):
        if os.fspath(path)==MANIFEST:
            assert flags & os.O_NOFOLLOW and not flags & os.O_CREAT
            return fake_fd
        return original_open(path,flags,*args,**kwargs)
    def resolved(path,strict=False):
        if str(path)==MANIFEST:return Path('/nix/store/rebound/manifest.json') if rebound else path
        return resolve(path,strict=strict)
    with patch.object(os,'open',side_effect=opened), \
         patch.object(os,'read',side_effect=lambda fd,count:raw[:count] if fd==fake_fd else original_read(fd,count)), \
         patch.object(os,'fstat',side_effect=lambda fd:SimpleNamespace(st_mode=stat.S_IFREG|0o444,st_uid=0,st_size=len(raw)) if fd==fake_fd else original_stat(fd)), \
         patch.object(os,'close',side_effect=lambda fd:None if fd==fake_fd else original_close(fd)), \
         patch.object(Path,'resolve',resolved):
        yield


class ToolkitManifestArtifactTests(unittest.TestCase):
    def test_closed_artifact_pair_and_legacy_string_use_same_real_decoder(self):
        with immutable_ports():
            self.assertEqual(T.immutable_manifest(PAIR),VALUE)
            self.assertEqual(T.immutable_manifest(MANIFEST),VALUE)

    def test_mismatched_pair_refuses_before_decoding(self):
        with immutable_ports(),patch.object(T.json,'loads',side_effect=AssertionError('No decode after hash mismatch')):
            with self.assertRaisesRegex(ValueError,'ARTIFACT_CHANGED'):
                T.immutable_manifest({**PAIR,'sha256':'f'*64})

    def test_closed_pair_rejects_unknown_fields_types_mutable_and_rebound_paths(self):
        for value in (None,True,17,[MANIFEST],{**PAIR,'extra':True},{'path':MANIFEST},{**PAIR,'sha256':None},
                      {**PAIR,'sha256':'A'*64},{**PAIR,'path':{'path':MANIFEST}},
                      {**PAIR,'path':'/tmp/not-immutable'}):
            with self.subTest(value=value),immutable_ports(),self.assertRaises(ValueError):T.immutable_manifest(value)
        with immutable_ports(rebound=True),self.assertRaisesRegex(ValueError,'IMMUTABLE_TOOLKIT'):
            T.immutable_manifest(PAIR)

    def test_manifest_schema_and_byte_bound_remain_closed(self):
        for value in ({**VALUE,'version':True},{**VALUE,'files':list(T.FILES)},
                      {**VALUE,'static':False},{**VALUE,'files':{}}):
            raw=json.dumps(value).encode();pair={**PAIR,'sha256':hashlib.sha256(raw).hexdigest()}
            with self.subTest(value=value),immutable_ports(raw),self.assertRaises(ValueError):T.immutable_manifest(pair)
        with immutable_ports(b'x'*8193),self.assertRaises(ValueError):T.immutable_manifest(PAIR)


class LifecycleManifestConsumerContractTests(unittest.TestCase):
    def test_actual_policy_producer_artifact_reaches_real_manifest_consumer(self):
        self.producer(False)

    def test_actual_producer_bad_artifact_never_publishes_or_installs_a_unit(self):
        self.producer(True)

    def producer(self,corrupt):
        fixture=lifecycle_fixture.GenerationFlow(methodName='runTest');fixture.setUp();self.addCleanup(fixture.doCleanups)
        fixture.initial.runtime.value['toolkitManifest']={**PAIR,'sha256':'f'*64} if corrupt else dict(PAIR)
        observed=[]
        class Consumer:
            def __init__(self,path,expected):
                self.raw=L.private_bytes(path)[0];self.expected=expected
                value=json.loads(self.raw);observed.append(value['toolkitManifest'])
                self.toolkit=T.immutable_manifest(value['toolkitManifest'])
            def guard(self):L.need(L._sha(self.raw)==self.expected,'POLICY_HASH_CHANGED')
            def close(self):pass
        with immutable_ports(),patch('reverie.owner_terminal_native.Installation',Consumer):
            if corrupt:
                with self.assertRaisesRegex(ValueError,'ARTIFACT_CHANGED'):fixture.prepare()
                self.assertFalse(fixture.unit.exists())
                self.assertFalse((fixture.control/L.CONTROL_PENDING).exists())
                self.assertFalse((fixture.control/L.CONTROL_CURRENT).exists())
            else:
                result=fixture.prepare();self.assertTrue(fixture.unit.exists())
                policy=json.loads(Path(result['policyPath']).read_bytes())
                self.assertEqual(policy['toolkitManifest'],PAIR)
        self.assertEqual(observed,[fixture.initial.runtime.value['toolkitManifest']])
