"""Disposable private roots and synthetic engine metadata; never a live broker."""
import base64
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from reverie.worker import OfficeAPI
from reverie.worker_recovery_auth import (
    DOMAIN, HEADER, RecoveryRequestSigner, document, is_recovery_request, paths,
    provision, recovery_forward_headers,
)

SID = '11111111-2222-3333-4444-555555555555'
EID = '66666666-7777-8888-9999-aaaaaaaaaaaa'
TARGET = '/api/company/employees/' + EID + '/reconnect'


class WorkerRecoveryAuthenticationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='recovery-auth-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        for name in ('company', 'company/console', 'work', 'scratch', 'office', 'state', 'state/employees'):
            (self.root / name).mkdir(mode=0o700)
        self.config = dict(companyRoot=str(self.root / 'company'), uid=os.getuid(),
                           companyFile=str(self.root / 'company/console/company.json'),
                           mounts=[{'source': str(self.root / 'work')}], scratchRoot=str(self.root / 'scratch'),
                           apiSocketRoot=str(self.root / 'office'), stateRoot=str(self.root / 'state'))
        self.company = {'employees': [dict(id=EID, sessionId=SID, sessionGeneration=7, desiredRunning=True,
                                           permissions={'recoverEmployees': True})]}
        self.write_company()
        self.inventory = []
        self.calls = []

    def write_company(self):
        path = Path(self.config['companyFile'])
        path.write_text(json.dumps(self.company)); path.chmod(0o600)

    def engine(self, args):
        self.calls.append(args)
        if args[0] == 'ps':
            return subprocess.CompletedProcess(args, 0, ''.join(row['Id'] + '\n' for row in self.inventory), '')
        if args[0] == 'inspect':
            return subprocess.CompletedProcess(args, 0, json.dumps(self.inventory), '')
        raise AssertionError('Only metadata inspection is allowed')

    def prepare(self):
        return provision(self.config, self.engine)

    def signer(self):
        self.prepare()
        return RecoveryRequestSigner(self.config, self.engine, now=lambda: 1000, nonce=lambda: 'b' * 32)

    def test_explicit_prepare_is_private_idempotent_and_never_resets_used_nonces(self):
        self.assertEqual(self.prepare(), {'prepared': True, 'created': True})
        root, auth, nonce = paths(self.config)
        key = auth.read_bytes()
        ledger = json.loads(nonce.read_bytes())
        ledger['revision'] = 9
        ledger['entries'] = [{'key': 'a' * 64, 'claimId': EID, 'expiresAt': 5000}]
        nonce.write_text(json.dumps(ledger))
        self.assertEqual(self.prepare(), {'prepared': True, 'created': False})
        self.assertEqual(auth.read_bytes(), key)
        self.assertEqual(json.loads(nonce.read_bytes()), ledger)
        for p in (auth, nonce, Path(str(nonce) + '.lock')):
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)

    def test_partial_preparation_refuses_without_filling_in_or_replacing_state(self):
        _, auth, nonce = paths(self.config)
        nonce.write_text('retained'); nonce.chmod(0o600)
        with self.assertRaises(ValueError): self.prepare()
        self.assertFalse(auth.exists()); self.assertEqual(nonce.read_text(), 'retained')

    def test_pending_or_corrupted_nonce_state_never_reports_ready_or_resets_history(self):
        self.prepare()
        _, auth, nonce = paths(self.config)
        key = auth.read_bytes()
        pending = Path(str(nonce) + '.pending'); pending.write_text('retained uncertain update')
        with self.assertRaises(ValueError): self.prepare()
        self.assertEqual(pending.read_text(), 'retained uncertain update')
        pending.unlink()
        nonce.write_text('{}')
        with self.assertRaises(ValueError): self.prepare()
        self.assertEqual(nonce.read_text(), '{}'); self.assertEqual(auth.read_bytes(), key)

    def test_scoped_assertion_binds_exact_bytes_target_method_session_and_generation(self):
        signer = self.signer().bind(SID)
        body = b'{"sessionGeneration":7,"sessionId":"' + SID.encode() + b'"}'
        proof = signer.sign(SID, 'POST', TARGET, body)
        encoded, signature = proof.split('.')
        fields = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
        value, _, _ = document(paths(self.config)[1])
        self.assertEqual(fields, [1, 'worker-recovery-request', value['issuer'], value['epoch'], SID, 7,
                                  'POST', TARGET, hashlib.sha256(body).hexdigest(), 1000, 11000, 'b' * 32])
        self.assertEqual(signature, hmac.new(bytes.fromhex(value['key']), DOMAIN + encoded.encode(), hashlib.sha256).hexdigest())
        self.assertTrue(is_recovery_request('POST', '/api/plans/moves/force'))
        self.assertTrue(is_recovery_request('POST', '/api/plans/moves/stable-move-1/status'))
        self.assertFalse(is_recovery_request('POST', '/api/plans/moves/stable-move-1/resolve'))
        self.assertTrue(is_recovery_request('POST', TARGET + '/status'))

    def test_cross_language_fixture_matches_actual_host_signer(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/worker-recovery-request.json').read_bytes())
        self.prepare()
        paths(self.config)[1].write_text(json.dumps(fixture['config']))
        signer = RecoveryRequestSigner(self.config, self.engine, now=lambda: fixture['issuedMs'], nonce=lambda: fixture['nonce']).bind(SID)
        self.assertEqual(signer.sign(SID, fixture['method'], fixture['target'], fixture['body'].encode()), fixture['assertion'])

    def test_arbitrary_routes_queries_identity_headers_and_oversized_bodies_never_get_signed(self):
        signer = self.signer().bind(SID)
        for method, target, sid, body in [('GET', TARGET, SID, b''), ('POST', TARGET + '?x=1', SID, b'{}'),
                ('POST', '/api/goals', SID, b'{}'), ('POST', '/api/sessions', SID, b'{}'),
                ('POST', TARGET, EID, b'{}'), ('POST', TARGET, SID, b'x' * 65537)]:
            with self.subTest(method=method, target=target), self.assertRaises(ValueError):
                signer.sign(sid, method, target, body)

    def test_stale_generation_owner_vacation_migration_and_stopped_office_are_refused(self):
        for change in ({'sessionGeneration': 8}, {'owner': 'different-owner'}, {'onVacation': True},
                       {'bindingMigration': {'id': 'pending'}}, {'desiredRunning': False}):
            with self.subTest(change=change):
                original = dict(self.company['employees'][0])
                signer = self.signer().bind(SID)
                self.company['employees'][0].update(change); self.write_company()
                with self.assertRaises(ValueError): signer.sign(SID, 'POST', TARGET, b'{}')
                self.company['employees'][0] = original; self.write_company()

    def test_changed_key_or_rebound_file_is_not_silently_adopted(self):
        signer = self.signer().bind(SID)
        _, auth, _ = paths(self.config)
        raw = auth.read_bytes()
        auth.unlink(); auth.write_bytes(raw); auth.chmod(0o600)
        with self.assertRaises(ValueError): signer.sign(SID, 'POST', TARGET, b'{}')

    def test_configured_or_actual_mount_exposure_and_aliases_refuse_before_key_access(self):
        self.prepare()
        for source in (self.root / 'company', self.root / 'company/console'):
            self.inventory = [dict(Id='a' * 64, Mounts=[dict(Type='bind', Source=str(source))])]
            with self.subTest(source=source), patch('reverie.worker_recovery_auth.document') as reader:
                with self.assertRaises(ValueError): RecoveryRequestSigner(self.config, self.engine).bind(SID)
                reader.assert_not_called()
        self.inventory = []
        alias = self.root / 'alias'; alias.symlink_to(self.root / 'company/console')
        self.config['mounts'] = [{'source': str(alias)}]
        with self.assertRaises(ValueError): RecoveryRequestSigner(self.config, self.engine).bind(SID)

    def test_supplied_proofs_are_always_stripped_and_missing_provisioning_fails_closed(self):
        incoming = {'x-reverie-recovery-assertion': 'forged', 'X-Reverie-Recovery-Other': 'forged', 'Accept': 'application/json'}
        self.assertEqual(recovery_forward_headers(SID, 'GET', '/api/company', b'', incoming), {'Accept': 'application/json'})
        with self.assertRaises(ValueError): recovery_forward_headers(SID, 'POST', TARGET, b'{}', incoming)
        forwarded = recovery_forward_headers(SID, 'POST', TARGET, b'{}', incoming, self.signer().bind(SID))
        self.assertEqual(set(forwarded), {'Accept', HEADER}); self.assertNotEqual(forwarded[HEADER], 'forged')

    def test_selected_account_sibling_mount_does_not_expose_private_recovery_files(self):
        accounts = self.root / 'company/console/accounts'
        accounts.mkdir(mode=0o700)
        self.inventory = [dict(Id='a' * 64, Mounts=[dict(Type='bind', Source=str(accounts))])]
        self.assertTrue(self.prepare()['prepared'])
        self.assertTrue(RecoveryRequestSigner(self.config, self.engine).bind(SID).sign(SID, 'POST', TARGET, b'{}'))

    def test_office_forwarding_issues_its_own_bound_proof_without_accepting_worker_identity(self):
        signer = self.signer()
        console = self.root / 'company/console'
        (console / '.env').write_text('REVERIE_USERNAME=fixture\nREVERIE_PASSWORD=synthetic\n')
        calls = []
        class Response:
            status = 200
            def getheaders(self): return [('Content-Length', '2')]
            def read1(self, _):
                if getattr(self, 'done', False): return b''
                self.done = True; return b'{}'
        class Upstream:
            def __init__(self, *args, **kwargs): self.sock = None
            def request(self, method, path, body, headers): calls.append((method, path, body, headers))
            def getresponse(self): return Response()
            def close(self): pass
        original = http.client.HTTPConnection
        office = OfficeAPI(self.root / 'phone', SID, 'fixture-upstream', self.root / 'company', recovery_auth=signer)
        self.addCleanup(office.close)
        with patch('reverie.worker.http.client.HTTPConnection', Upstream):
            connection = original('localhost'); transport = socket.socket(socket.AF_UNIX)
            transport.connect(str(self.root / 'phone/office.sock')); connection.sock = transport
            connection.request('POST', TARGET, body=b'{}', headers={'X-Reverie-Parent-Session': EID, HEADER: 'forged'})
            response = connection.getresponse(); self.assertEqual(response.status, 200); response.read(); connection.close()
        self.assertEqual(calls[0][3]['X-Reverie-Parent-Session'], SID)
        self.assertNotEqual(calls[0][3][HEADER], 'forged')
        fields = json.loads(base64.urlsafe_b64decode(calls[0][3][HEADER].split('.')[0] + '=='))
        self.assertEqual(fields[4:6], [SID, 7])
