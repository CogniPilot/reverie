"""Real private metadata/lock/checkpoint closure with synthetic native ports."""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from reverie import owner_terminal_cold_abort as C
from reverie import owner_terminal_lifecycle as L
from reverie import owner_terminal_website as H
from tests import test_owner_terminal_website as fixtures
from tests import test_website_update as W


class OwnerColdAbortTests(unittest.TestCase):
    def setUp(self):
        self.core=fixtures.TerminalWebsiteStageTests(methodName='runTest');self.core.setUp();self.addCleanup(self.core.doCleanups)
        self.f=self.core.fixture;self.i=self.core.initial;self.root=self.f.root
        self.f.state=self.i.roots['ledgerBase']/'website-updates'
        self.f.guard.value['websiteControlBinding']['stateDirectory']=str(self.f.state)
        self.core.rebuild()
        self.home=self.root/'owned-home';self.home.mkdir(mode=0o700)
        self.enterContext(patch.object(Path,'home',return_value=self.home))
        self.core.phase_failure='prepare-created';self.plan=self.core.approve()
        with self.assertRaises(W.website.WebsiteRefusal):self.core.stage.apply(self.plan,W.website.digest(self.plan))
        self.operation=self.f.state/('website-'+self.plan['operationId'])
        self.receipt=(self.f.state/'website-active.json').read_bytes()
        old=self.f.engine.containers[W.OLD];candidate=self.f.engine.containers[W.NEW]
        candidate['State'].update(Status='created',StartedAt='0001-01-01T00:00:00Z',FinishedAt='0001-01-01T00:00:00Z',ExitCode=0,OOMKilled=False,Error='')
        self.evidence=self.root/'operator-evidence';self.evidence.mkdir(mode=0o700)
        self.write(self.evidence/'parent-receipt.private.json',self.receipt)
        self.write(self.evidence/'old-before.private.json',H.encoded(old))
        self.write(self.evidence/'candidate-before.private.json',H.encoded(candidate))
        intent={'kind':'explicit-owner-prestart-cold-abort-v1','reason':'owned test','oldId':W.OLD,'newId':W.NEW,
                'oldImage':W.OLD_IMAGE,'candidateNeverStarted':True,'schemaState':'not-started',
                'parentReceiptSHA256':hashlib.sha256(self.receipt).hexdigest(),'heldCandidateName':'owned-held-candidate',
                'automaticRollback':False,'preserveAllFences':True,'databaseRestore':False}
        self.write(self.evidence/'ATTEMPT.json',H.encoded(intent))
        report={'state':'OWNER_COLD_ABORT_RESTORED_ORIGINAL','websiteReady':True,'workersPreserved':True,'workers':1,
                'siteImage':W.OLD_IMAGE,'parentFencesPreserved':True,'heldCandidate':'owned-held-candidate'}
        self.write(self.evidence/'result.json',H.encoded(report))
        for name in ('workers-before.private.json','workers-after.private.json'):self.write(self.evidence/name,b'[]')
        old['Name']='/reverie';old['State'].update(Running=True,Pid=9877,StartedAt='owner-restored-incarnation')
        candidate['Name']='/owned-held-candidate'
        generation='12345678-1234-4234-8234-123456789abc'
        self.orphan=self.i.roots['controlBase']/generation;self.orphan.mkdir(mode=0o700)
        (self.i.roots['ledgerBase']/generation).mkdir(mode=0o700)
        self.entry=Path('/nix/store/owned-native/scripts/reverie-owner-terminal-host')
        self.i.host_program={'argvPrefix':['/nix/store/python/bin/python','-I','-B',str(self.entry)]}
        policy={'controlRoot':str(self.orphan),'ledgerRoot':str(self.i.roots['ledgerBase']/generation),
                'bootstrapRoot':str(self.i.roots['bootstrapRoot']),'website':{'containerId':W.NEW,'initPid':None,'initStart':None},
                'hostProgram':{'argv':[self.i.host_program['argvPrefix'][0],'-I','-B',str(self.entry),'--policy',str(self.orphan/'installation.json')]}}
        self.write(self.orphan/'installation.json',H.encoded(policy))
        original_stat,original_bytes=Path.stat,Path.read_bytes
        self.enterContext(patch.object(Path,'stat',lambda p,*a,**k:SimpleNamespace(st_uid=0,st_mode=0o100555) if p==self.entry else original_stat(p,*a,**k)))
        self.enterContext(patch.object(Path,'read_bytes',lambda p:b'fixed immutable entry' if p==self.entry else original_bytes(p)))
        self.i.unit_state=lambda:{'LoadState':'not-found','MainPID':'0','ActiveState':'inactive'}
        class Engine:
            def get(inner,path):
                cid=path[12:-5];return deepcopy(self.f.engine.containers[cid])
        self.i.engine=Engine()
        self.baseline=self.root/'provider-baseline.json';self.write(self.baseline,b'[]')
        providers=[{'containerId':'owned-laptop','process':{'pid':12,'start':34,'exe':(1,2),'namespaces':(3,4,5)}}]
        self.enterContext(patch.object(H,'qualify_provider_baseline',return_value=providers))
        self.core.rebuild();self.stage=self.core.stage
        parent=self.i.roots['ledgerBase']/'website-cold-aborts';parent.mkdir(mode=0o700)
        self.folder=parent/str(uuid.uuid4());self.folder.mkdir(mode=0o700)
        selector={'providerPIDs':[12]};self.write(self.folder/'selection.json',H.encoded(selector))
        self.write(self.folder/'ORIGINAL_SELECTION.json',H.encoded(selector))
        self.write(self.i.roots['ledgerBase']/'website-selection.json',H.encoded(selector))
        self.native=SimpleNamespace(name='reverie',selection=selector,selection_path=self.folder/'selection.json',snapshot=self.f.guard.snapshot)

    @staticmethod
    def write(path,raw):path.write_bytes(raw);path.chmod(0o600)

    def prepare(self):return C.prepare(self.i,W.website,self.native,self.stage,self.folder,self.evidence,self.baseline)

    def test_roundtrip_keeps_all_parent_bytes_and_permits_future_normal_plan(self):
        before=C.parent_files(self.operation,W.website);result=self.prepare()
        ack=C.apply(self.i,W.website,self.native,self.stage,self.folder,result['planDigest'])
        self.assertEqual(ack['state'],'OWNER_ABORTED_NEVER_STARTED')
        self.assertEqual(C.parent_files(self.operation,W.website),before)
        self.assertEqual((self.operation/'receipt.private.json').read_bytes(),self.receipt)
        self.assertEqual((self.f.state/'website-active.json').read_bytes(),self.receipt)
        self.assertFalse((self.operation/'H-prepare-created-RESULT.json').exists())
        C.verify(self.i,json.loads(self.receipt),{'oldId':W.OLD,'oldImage':W.OLD_IMAGE})
        self.i.require_old_settled()
        review=json.loads(self.f.policy.read_bytes());review.update(reviewId='new-explicit-owner-review',approvedSpecDigest=None)
        self.write(self.f.policy,H.encoded(review))
        future=self.stage.plan('reverie',W.NEW_IMAGE,W.OLD,W.OLD_IMAGE)
        self.assertNotEqual(future['operationId'],self.plan['operationId'])
        with self.assertRaises(ValueError):C.apply(self.i,W.website,self.native,self.stage,self.folder,result['planDigest'])

    def test_wrong_approved_SHA_refuses_without_consuming_any_marker(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError,'REVIEWED_PLAN'):C.apply(self.i,W.website,self.native,self.stage,self.folder,'sha256:'+'0'*64)
        self.assertFalse((self.operation/C.ATTEMPT).exists())

    def test_full_mount_metadata_or_failed_start_evidence_refuses(self):
        for mutation in ('mode','start-error','oom','started'):
            with self.subTest(mutation=mutation):
                row=self.f.engine.containers[W.NEW];original=deepcopy(row)
                if mutation=='mode':row['Mounts'][0]['Mode']='changed'
                elif mutation=='start-error':row['State']['Error']='failed startup'
                elif mutation=='oom':row['State']['OOMKilled']=True
                else:row['State']['StartedAt']='started-and-exited'
                with self.assertRaises(ValueError):C.observe(self.i,W.website,self.native,self.evidence,self.baseline)
                row.clear();row.update(original)

    def test_unknown_orphan_or_issued_ledger_and_published_generation_refuse(self):
        ledger=Path(json.loads((self.orphan/'installation.json').read_bytes())['ledgerRoot'])
        for path in (self.orphan/'unexpected',ledger/'issued-context.json',self.i.roots['controlBase']/L.CONTROL_PENDING):
            self.write(path,b'{}')
            with self.assertRaises(ValueError):C.observe(self.i,W.website,self.native,self.evidence,self.baseline)
            path.unlink()

    def test_native_drift_before_apply_retains_every_parent_and_does_not_ack(self):
        result=self.prepare();self.f.guard.value['changedObservation']=True
        with self.assertRaisesRegex(ValueError,'NATIVE_CAS'):C.apply(self.i,W.website,self.native,self.stage,self.folder,result['planDigest'])
        self.assertFalse((self.operation/C.ATTEMPT).exists())
        self.assertFalse((self.i.roots['controlBase']/C.POINTER).exists())

    def test_future_ack_refuses_candidate_changes_or_missing_parent(self):
        result=self.prepare();C.apply(self.i,W.website,self.native,self.stage,self.folder,result['planDigest'])
        row=self.f.engine.containers[W.NEW];row['Config']['User']='0:0'
        with self.assertRaisesRegex(ValueError,'CANDIDATE_STARTED_OR_CHANGED'):C.verify(self.i)
        row['Config']['User']=self.plan['spec']['User']
        (self.operation/'H-prepare-created-ATTEMPT.json').rename(self.root/'retained-attempt')
        with self.assertRaises(ValueError):C.verify(self.i)
