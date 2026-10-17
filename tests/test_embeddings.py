import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import unittest

from cto.embeddings import HashedEmbedder, cosine, make_embedder, pack, unpack


class HashedEmbedderTest(unittest.TestCase):
    def setUp(self):
        self.e = HashedEmbedder(256)

    def test_deterministic_and_normalised(self):
        a = self.e.embed("User is building a Modelica compiler")
        b = self.e.embed("User is building a Modelica compiler")
        self.assertEqual(a, b)
        self.assertEqual(len(a), 256)
        self.assertAlmostEqual(sum(x * x for x in a), 1.0, places=6)

    def test_similar_texts_closer_than_unrelated(self):
        q = self.e.embed("the rust borrow checker is fighting me")
        near = self.e.embed("rust borrow checker errors again")
        far = self.e.embed("my cat likes tuna for dinner")
        self.assertGreater(cosine(q, near), cosine(q, far))

    def test_empty_text(self):
        v = self.e.embed("the and of")
        self.assertEqual(len(v), 256)
        self.assertEqual(cosine(v, v), 0.0)

    def test_pack_roundtrip(self):
        v = self.e.embed("hello world")
        self.assertEqual(len(unpack(pack(v))), 256)
        self.assertAlmostEqual(cosine(v, unpack(pack(v))), 1.0, places=5)
        self.assertEqual(unpack(None), [])

    def test_make_embedder_falls_back(self):
        emb = make_embedder("http://127.0.0.1:1/v1", "none", 64)
        self.assertIsInstance(emb, HashedEmbedder)
        self.assertEqual(emb.dims, 64)


if __name__ == "__main__":
    unittest.main()
