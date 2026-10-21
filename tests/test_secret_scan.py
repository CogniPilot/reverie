import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import unittest
from cto.secret_scan import find, leaks


class SecretScanTests(unittest.TestCase):
    def test_real_credential_shapes_are_found_by_name_only(self):
        samples={
            'openai_or_anthropic_key':'key \x73k-ant-api03-abcdefghijklmnopqrstuv',
            'stripe_key':'sk_live_abcdefghijklmnop1234',
            'github_token':'\x67hp_abcdefghijklmnopqrstuvwxyz0123456789',
            'slack_token':'\x78oxb-1234567890-abcdefghij',
            'aws_access_key':'\x41KIAABCDEFGHIJKLMNOP',
            'google_api_key':'AIza'+'A'*35,
            'huggingface_token':'hf_'+'a'*34,
            'gitlab_token':'glpat-abcdefghijklmnopqrst',
            'jwt':'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmn',
            'private_key':'\x2d----BEGIN OPENSSH PRIVATE KEY-----',
            'url_credentials':'https://user:hunter2@example.com/repo',
            'authorization_header':'Authorization: Bearer abcdefgh12345678',
            'webhook_url':'https://hooks.slack.com/services/T000/B000/XXXX',
            'netrc_password':'machine example.com login me password hunter22',
            'assigned_secret':'{"password": "correct-horse-battery"}',
        }
        for name,text in samples.items():
            with self.subTest(name): self.assertIn(name,find(text))
        self.assertIn('assigned_secret',find("API_KEY='abcd1234efgh'"))
        self.assertIn('high_entropy_token',find('token Zx9Qm2Lp8Rt4Vn6Bc1Hd5Jf7Kg3Ws0Ya'))

    def test_underscore_joined_keys_and_bare_bearer_tokens(self):
        for text in ('"client_secret": "abcd1234efgh5678"', '"access_token": "abcd1234efgh5678"',
                     'DB_PASSWORD=hunter2hunter2', "SECRET_KEY = 'abcdefgh12345'", 'auth_token=abcdefgh1234',
                     'aws_secret_access_key = abcdEFGH1234ijkl', 'OPENAI_API_KEY=sk12345678',
                     'curl -H "Bearer abcdefghijklmnop1234"'):
            with self.subTest(text): self.assertTrue(leaks(text), text)

    def test_ordinary_engineering_text_is_not_flagged(self):
        for text in ('<task-notification> the risk-free disk-check ask-me flow',
                     'commit 9545b58a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f merged',
                     'session 00000006-0006-4000-8000-000000000006 is pinned',
                     'the password reset flow and token budget were discussed',
                     'sk-short', 'see /scratch/worktrees/example-project/work',
                     'token = tokenizer.encode(text)', 'password: [REDACTED]', 'max_tokens = 4096',
                     'a sk-learn-compatible-estimator-api'):
            with self.subTest(text): self.assertFalse(leaks(text), find(text))


if __name__=='__main__': unittest.main()
