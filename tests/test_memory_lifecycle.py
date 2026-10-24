import gc
import sqlite3
import unittest
import weakref

from reverie.memory import MemoryStore


class MemoryLifecycleTests(unittest.TestCase):
    def test_abandoned_store_closes_its_connection(self):
        store = MemoryStore(':memory:')
        connection = store._db
        reference = weakref.ref(store)
        del store
        gc.collect()
        self.assertIsNone(reference())
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute('SELECT 1')

    def test_explicit_close_and_collection_are_idempotent(self):
        store = MemoryStore(':memory:')
        connection = store._db
        store.close()
        store.close()
        del store
        gc.collect()
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute('SELECT 1')
