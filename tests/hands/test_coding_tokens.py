import unittest
from types import SimpleNamespace

from coding_model_client import ModelClient
from coding_tokens import TokenMeter


class TokenTests(unittest.TestCase):
    def meter(self, *, context=65536, slots=1, count=100):
        meter = TokenMeter('http://127.0.0.1:9999', context_ceiling=65536)
        requests = []
        def request(path, payload=None):
            requests.append((path, payload))
            if path == '/props':
                return {'default_generation_settings': {'n_ctx': context}, 'total_slots': slots}
            if path == '/apply-template':
                return {'prompt': 'system tool read_file task'}
            return {'tokens': [1] * count}
        meter.request = request
        return meter, requests

    def test_actual_context_includes_tools_output_reserve_and_margin(self):
        meter, requests = self.meter()
        payload = {'messages': [{'role': 'user', 'content': 'task'}], 'max_tokens': 1024,
                   'tools': [{'type': 'function', 'function': {'name': 'read_file'}}]}
        result = meter.measure(payload)
        self.assertTrue(result['admitted'])
        self.assertEqual(result['context_tokens'], 65536)
        self.assertEqual(result['prompt_tokens'], 100)
        self.assertEqual(requests[1], ('/apply-template', payload))
        self.assertTrue(requests[2][1]['parse_special'])

    def test_zero_router_context_and_unvalidated_parallel_slots_refuse(self):
        for context, slots in ((0, 1), (65536, 2), (True, 1), (65536, True)):
            with self.subTest(context=context, slots=slots):
                meter, requests = self.meter(context=context, slots=slots)
                with self.assertRaises(ValueError):
                    meter.measure({'max_tokens': 1024})
                self.assertEqual(len(requests), 1)

    def test_output_tokens_and_margin_prevent_near_context_overflow(self):
        meter, _ = self.meter(context=1024, count=600)
        self.assertFalse(meter.measure({'max_tokens': 256})['admitted'])

    def test_missing_tool_template_refuses_before_generation(self):
        meter, _ = self.meter()
        with self.assertRaises(ValueError):
            meter.measure({'max_tokens': 1024, 'tools': [{'function': {'name': 'not_in_template'}}]})

    def test_client_never_generates_when_token_admission_refuses(self):
        client = ModelClient('http://127.0.0.1:9999/v1')
        client.token_meter = SimpleNamespace(measure=lambda payload: {
            'admitted': False, 'prompt_tokens': 70000, 'context_tokens': 65536})
        class Forbidden:
            def open(self, *args, **kwargs):
                raise AssertionError('generation must not start')
        client.opener = Forbidden()
        result = client({'model': 'configured-model', 'max_tokens': 1024}, 1)
        self.assertTrue(result['_context_overflow'])


if __name__ == '__main__':
    unittest.main()
