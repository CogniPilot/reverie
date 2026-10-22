import json
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, stream, code, message, headers, new_url):
        return None


class TokenMeter:
    def __init__(self, base_url, *, context_ceiling, margin=512, timeout_s=3, max_bytes=1048576):
        parsed = urllib.parse.urlsplit(base_url)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or
                parsed.query or parsed.fragment):
            raise ValueError('invalid tokenizer endpoint')
        if type(context_ceiling) is not int or context_ceiling <= 0 or type(margin) is not int or margin < 0:
            raise ValueError('invalid token budget')
        self.base_url = base_url.rstrip('/')
        self.context_ceiling, self.margin = context_ceiling, margin
        self.timeout_s, self.max_bytes = timeout_s, max_bytes
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, payload=None):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(self.base_url + path, data=data,
                                         headers={'Content-Type': 'application/json'})
        with self.opener.open(request, timeout=self.timeout_s) as stream:
            raw = stream.read(self.max_bytes + 1)
        if len(raw) > self.max_bytes:
            raise ValueError('tokenizer response limit')
        return json.loads(raw)

    def measure(self, payload):
        properties = self.request('/props')
        actual = properties.get('default_generation_settings', {}).get('n_ctx')
        slots = properties.get('total_slots')
        if type(actual) is not int or actual <= 0 or type(slots) is not int or slots != 1:
            raise ValueError('unsupported or unknown per-slot context')
        completion = payload.get('max_tokens')
        if type(completion) is not int or completion <= 0:
            raise ValueError('explicit positive output-token budget required')
        prompt = self.request('/apply-template', payload).get('prompt')
        if not isinstance(prompt, str):
            raise ValueError('invalid formatted prompt')
        for tool in payload.get('tools', []):
            if tool['function']['name'] not in prompt:
                raise ValueError('tool schema omitted by tokenizer template')
        tokens = self.request('/tokenize', {'content': prompt, 'add_special': True,
                                           'parse_special': True, 'with_pieces': False}).get('tokens')
        if not isinstance(tokens, list) or any(type(token) is not int for token in tokens):
            raise ValueError('invalid tokenizer result')
        context = min(actual, self.context_ceiling)
        return {'prompt_tokens': len(tokens), 'context_tokens': context, 'output_tokens': completion,
                'margin': self.margin, 'slots': slots,
                'admitted': len(tokens) + completion + self.margin <= context}
