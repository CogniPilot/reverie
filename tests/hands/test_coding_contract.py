import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import agent_memory
from coding_chat import read_tool_specs
from coding_tasks import TOOL_NAMES


class ToolExportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'schemas.json'
        self.export = json.loads((Path(__file__).parent / 'fixtures' / 'tool-specs-v1.json').read_text())

    def load(self, export):
        self.path.write_text(json.dumps(export))
        return read_tool_specs(self.path)

    def test_sealed_dispatcher_envelope_returns_only_the_model_array(self):
        tools = self.load(self.export)
        self.assertEqual(tools, self.export['tools'])
        self.assertEqual({schema['function']['name'] for schema in tools}, TOOL_NAMES)
        self.assertIsInstance(tools, list)

    def test_changed_version_caps_and_extra_metadata_refuse(self):
        for field, value in [('version', 2), ('version', True), ('args_cap', 1),
                             ('result_cap', 48000), ('result_cap', True), ('extra', 1)]:
            with self.subTest(field=field, value=value):
                changed = dict(self.export, **{field: value})
                with self.assertRaises(ValueError):
                    self.load(changed)

    def test_bare_list_missing_fields_and_bad_tools_refuse(self):
        invalid = [self.export['tools'], {}, dict(self.export, tools=[]),
                   dict(self.export, tools={}), dict(self.export, tools=[None])]
        for export in invalid:
            with self.subTest(export=export), self.assertRaises(ValueError):
                self.load(export)
        for name in ['unknown', 'web_search', ['read_file']]:
            changed = copy.deepcopy(self.export)
            changed['tools'][0]['function']['name'] = name
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.load(changed)
        duplicate = dict(self.export, tools=self.export['tools'][:1] * 2)
        with self.assertRaises(ValueError):
            self.load(duplicate)

    def test_oversized_export_refuses(self):
        changed = copy.deepcopy(self.export)
        changed['tools'][0]['function']['description'] = 'x' * 17000
        with self.assertRaises(ValueError):
            self.load(changed)


class MemoryContractTests(unittest.TestCase):
    def test_recalled_exchange_uses_assistant_text_without_a_legacy_attribute(self):
        room = '00000000-0000-4000-8000-000000000001'
        source = '00000000-0000-4000-8000-000000000002'
        row = SimpleNamespace(id='episode-one', assistant_text='confirmed answer',
            user_text=json.dumps({'schema': 1, 'room': room, 'source': source,
                                  'at': 1, 'kind': 'exchange'}) + '\nquestion')
        store = SimpleNamespace(all=lambda: [row], retrieve=lambda *args, **kwargs: [row], close=lambda: None)
        with tempfile.TemporaryDirectory() as root:
            with patch.object(agent_memory, 'load_instance', return_value=SimpleNamespace(data_dir=Path(root))):
                memory = agent_memory.RoomMemory(Path(root) / 'instance.json', lambda value: 'shared')
            with patch.object(memory, '_open', return_value=store):
                text, sources = memory.recall(room, 'question')
        self.assertIn('confirmed answer', text)
        self.assertEqual(sources, [source])


if __name__ == '__main__':
    unittest.main()
