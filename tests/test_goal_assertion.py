import tests  # noqa: F401
import base64
import json
import unittest

from reverie.goal_assertion import GoalRequestSigner, goal_forward_headers, is_goal_request
from tests.goal_broker_fixture import SID, TEST_KEY, forward as office_forward
from tests.goal_broker_fixture import component_proof as forward


class GoalAssertionTests(unittest.TestCase):
    def signer(self, **overrides):
        options = dict(key=TEST_KEY, issuer='test-broker', epoch='test-epoch', binding=lambda _: 7,
                       now=lambda: 100_000, nonce=lambda: 'a'*32)
        return GoalRequestSigner(**{**options, **overrides}).bind(SID)

    def test_exact_closed_routes(self):
        for method, target in [('GET', '/api/goals'), ('GET', '/api/goals/g-1'),
                ('POST', '/api/goals'), ('POST', '/api/goals/g-1/transitions'),
                ('POST', '/api/goals/g-1/adopt'), ('POST', '/api/goals/g-1/unblock-proofs'),
                ('POST', '/api/goal-grants'), ('POST', '/api/goal-grants/gr-1/revoke'),
                ('POST', '/api/goal-unblock-proofs/p-1/revoke'), ('GET', '/api/goal-metadata/e-1?grantId=gr-1')]:
            with self.subTest(target=target):
                self.assertTrue(is_goal_request(method, target))
                self.assertTrue(self.signer().sign(SID, method, target, b'' if method == 'GET' else b'{}'))
        for target in ['/api/goals/', '/api/goals\n', '/api/goals?x=1', '/api/goals/../settings',
                       '/api/%67oals', '/api/goals/g-1/transitions?x=1', '/api/settings',
                       '/api/goal-metadata/e-1?grantId=x&grantId=y']:
            with self.subTest(target=target):
                self.assertFalse(is_goal_request('POST', target))
        self.assertFalse(is_goal_request('DELETE', '/api/goals'))

    def test_fixed_session_generation_fields_and_domain(self):
        token = self.signer().sign(SID, 'POST', '/api/goals', b'{"x":1}')
        encoded, signature = token.split('.')
        fields = json.loads(base64.urlsafe_b64decode(encoded+'='*((-len(encoded)) % 4)))
        self.assertEqual(fields[:8], [1, 'goal-request', 'test-broker', 'test-epoch', SID, 7, 'POST', '/api/goals'])
        self.assertEqual(fields[9:], [100_000, 110_000, 'a'*32])
        self.assertEqual(len(signature), 64)

    def test_malformed_and_unavailable_bindings_refused(self):
        for generation in [None, 0, -1, True, 1.5, 2**53]:
            with self.subTest(generation=generation), self.assertRaises(ValueError):
                self.signer(binding=lambda _: generation).sign(SID, 'POST', '/api/goals', b'{}')
        for sid in ['short', 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', SID+'\n']:
            with self.subTest(sid=sid), self.assertRaises(ValueError):
                self.signer().sign(sid, 'POST', '/api/goals', b'{}')
        for body in [b'x'*65537, '{}']:
            with self.assertRaises(ValueError): self.signer().sign(SID, 'POST', '/api/goals', body)
        with self.assertRaises(ValueError): self.signer().sign(SID, 'GET', '/api/goals', b'{}')
        with self.assertRaises(ValueError): self.signer(key=b'weak')

    def test_default_denies_before_upstream_or_environment_read(self):
        result = office_forward({'unavailable': True, 'headers': {'X-Reverie-Goal-Assertion': 'forged'}})
        self.assertEqual(result, {'refused': 403, 'upstream': False, 'environmentReads': 0})

    def test_current_office_refuses_even_valid_component_proof_before_environment_or_upstream(self):
        component = forward({})
        self.assertIn('X-Reverie-Goal-Assertion', component['headers'])
        for request in [{}, {'headers': component['headers']}, {'unavailable': False}]:
            with self.subTest(request=request):
                self.assertEqual(office_forward(request),
                                 {'refused': 403, 'upstream': False, 'environmentReads': 0})

    def test_proof_component_strips_goal_spoofing_with_explicit_synthetic_transport(self):
        result = forward({'headers': {'X-Reverie-Goal-Assertion': 'forged', 'X-Reverie-Goal-Principal': 'owner',
                                     'X-Reverie-Parent-Session': 'forged', 'Cookie': 'forged', 'Authorization': 'forged'}})
        self.assertEqual(result['headers']['X-Reverie-Parent-Session'], SID)
        self.assertNotIn('Cookie', result['headers'])
        self.assertNotIn('X-Reverie-Goal-Principal', result['headers'])
        self.assertEqual(result['headers']['X-Reverie-Goal-Assertion'], self.signer().sign(SID, 'POST', '/api/goals', b'{}'))

    def test_non_goal_forwarding_strips_all_assertions_without_signing(self):
        headers = goal_forward_headers(SID, 'POST', '/api/chatrooms', b'{}',
                                       {'X-Reverie-Goal-Assertion': 'forged', 'x-reverie-goal-other': 'owner', 'safe': 'kept'})
        self.assertEqual(headers, {'safe': 'kept'})

    def test_office_generation_is_pinned_and_cannot_adopt_a_rebind(self):
        generation = [7]
        signer = self.signer(binding=lambda _: generation[0])
        signer.sign(SID, 'POST', '/api/goals', b'{}')
        generation[0] = 8
        with self.assertRaises(ValueError): signer.sign(SID, 'POST', '/api/goals', b'{}')
        generation[0] = 7
        with self.assertRaises(ValueError): signer.sign('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'POST', '/api/goals', b'{}')

    def test_canonical_route_id_boundaries_through_proof_component(self):
        def routes(value):
            return [('GET', '/api/goals/'+value),
                    ('POST', '/api/goals/'+value+'/transitions'),
                    ('POST', '/api/goals/'+value+'/adopt'),
                    ('POST', '/api/goals/'+value+'/unblock-proofs'),
                    ('POST', '/api/goal-grants/'+value+'/revoke'),
                    ('POST', '/api/goal-unblock-proofs/'+value+'/revoke'),
                    ('GET', '/api/goal-metadata/'+value),
                    ('GET', '/api/goal-metadata/worker?grantId='+value),
                    ('GET', '/api/goal-metadata/'+value+'?grantId='+value)]
        for size in [64, 65, 100]:
            value = ('Aa0_.:-'*15)[:size]
            for method, target in routes(value):
                with self.subTest(size=size, method=method, target=target):
                    self.assertTrue(is_goal_request(method, target))
                    result = forward({'method': method, 'target': target, 'body': '' if method == 'GET' else '{}'})
                    self.assertEqual(result['target'], target)
                    self.assertIn('X-Reverie-Goal-Assertion', result['headers'])
        for value in ['x'*101, 'bad%41', 'bad/name', 'bad name', 'bad\n', 'nonascii-é', 'bad?extra=1']:
            for method, target in routes(value):
                with self.subTest(value=value, method=method):
                    self.assertFalse(is_goal_request(method, target))
                    self.assertEqual(forward({'method': method, 'target': target, 'body': '' if method == 'GET' else '{}'}),
                                     {'refused': 403, 'upstream': False, 'environmentReads': 0})

    def test_route_bound_change_does_not_widen_issuer_epoch_nonce_or_session(self):
        for field in ['issuer', 'epoch']:
            self.signer(**{field: 'x'*64})
            with self.assertRaises(ValueError): self.signer(**{field: 'x'*65})
        for nonce in ['a'*31, 'a'*33, 'A'*32]:
            with self.assertRaises(ValueError): self.signer(nonce=lambda: nonce).sign(SID, 'POST', '/api/goals', b'{}')
