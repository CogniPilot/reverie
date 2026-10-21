import tests  # noqa: F401
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cto.embeddings import HashedEmbedder
from cto.memory import LEGACY_ASSISTANT_COLUMN, SCHEMA, SCHEMA_VERSION, MemoryStore


class MemorySchemaTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "memory.sqlite"

    def legacy_store(self):
        connection = sqlite3.connect(self.path)
        connection.executescript(SCHEMA.replace("assistant_text", LEGACY_ASSISTANT_COLUMN))
        connection.execute(
            f'INSERT INTO memories(id,kind,created_at,user_text,"{LEGACY_ASSISTANT_COLUMN}",text,importance,embedding,meta) '
            'VALUES (?,?,?,?,?,?,?,?,?)',
            (42, "episode", 1234.5, "question", "answer", "User: question\nAssistant: answer", 7.0,
             b"\x00\x00\x80\x3f", json.dumps({"fixture": [1, 2, 3]})),
        )
        connection.execute("INSERT INTO state(key,value) VALUES (?,?)", ("existing", "retained"))
        connection.commit()
        values = connection.execute("SELECT * FROM memories").fetchall()
        connection.close()
        return values

    def test_legacy_column_is_renamed_without_rewriting_memory_rows(self):
        before = self.legacy_store()
        store = MemoryStore(self.path, HashedEmbedder(1))
        try:
            columns = {row["name"] for row in store._db.execute("PRAGMA table_info(memories)")}
            self.assertIn("assistant_text", columns)
            self.assertNotIn(LEGACY_ASSISTANT_COLUMN, columns)
            self.assertEqual(store._db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            self.assertEqual([tuple(row) for row in store._db.execute("SELECT * FROM memories")], before)
            self.assertEqual(store._db.total_changes, 0)
            self.assertEqual(store.get_state("existing"), "retained")
            memory = store.get(42)
            self.assertEqual(memory.assistant_text, "answer")
            self.assertEqual(memory.embedding, [1.0])
            self.assertEqual(memory.as_dict()["assistant_text"], "answer")
            self.assertNotIn(LEGACY_ASSISTANT_COLUMN, memory.as_dict())
            new = store.add_external_episode("new", user_text="next", assistant_text="reply")
            self.assertEqual(new.assistant_text, "reply")
        finally:
            store._db.close()
        reopened = MemoryStore(self.path, HashedEmbedder(1))
        try:
            self.assertEqual(reopened.get(42).assistant_text, "answer")
            self.assertEqual(reopened.count(), 2)
            self.assertEqual(reopened._db.total_changes, 0)
        finally:
            reopened._db.close()

    def test_new_stores_expose_only_the_generic_assistant_field(self):
        store = MemoryStore(self.path)
        try:
            memory = store.add_episode(user_text="question", assistant_text="answer")
            self.assertEqual(memory.assistant_text, "answer")
            self.assertEqual(memory.as_dict()["assistant_text"], "answer")
            self.assertNotIn(LEGACY_ASSISTANT_COLUMN, memory.as_dict())
        finally:
            store._db.close()

    def test_failed_schema_version_update_rolls_back_column_rename(self):
        before = self.legacy_store()
        connection = sqlite3.connect(self.path)
        connection.set_authorizer(lambda action, name, value, *_: sqlite3.SQLITE_DENY
                                  if action == sqlite3.SQLITE_PRAGMA and name == "user_version" and value is not None
                                  else sqlite3.SQLITE_OK)
        with patch("cto.memory.sqlite3.connect", return_value=connection):
            with self.assertRaises(sqlite3.DatabaseError):
                MemoryStore(self.path)
        with sqlite3.connect(self.path) as original:
            columns = {row[1] for row in original.execute("PRAGMA table_info(memories)")}
            self.assertIn(LEGACY_ASSISTANT_COLUMN, columns)
            self.assertNotIn("assistant_text", columns)
            self.assertEqual(original.execute("PRAGMA user_version").fetchone()[0], 0)
            self.assertEqual(original.execute("SELECT * FROM memories").fetchall(), before)
