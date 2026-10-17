"""Text embeddings for episodic recall.

Two backends share one interface:

* :class:`HashedEmbedder`: pure Python, CPU only, no dependencies. Words and word
  bigrams are hashed into a fixed number of buckets with a sign hash, weighted by
  sublinear term frequency, and L2-normalised. Recall never depends on the GPU.
* :class:`LlamaEmbedder`: POSTs to a llama-server ``/v1/embeddings`` endpoint
  (for example nomic-embed-text-v1.5 as a small GGUF served on the CPU). Models of
  that family want ``search_document: `` and ``search_query: `` prefixes, which the
  backend adds by ``kind``.

Vectors are stored as packed float32 and compared with cosine similarity.
"""
from __future__ import annotations

import array
import hashlib
import json
import math
import re
import urllib.request
from typing import Iterable, Protocol, Sequence

_WORD = re.compile(r"[a-z0-9']+")
STOPWORDS = frozenset(
    "a an the and or but if then so of to in on at by for with from as is are was were be been being am "
    "i me my you your he she it its we they them this that these those do does did have has had not no "
    "yes just like about what which who whom how when where why there here very can could would should "
    "will shall may might must oh ok okay hey hi hello well too also ever even really".split()
)


class Embedder(Protocol):
    name: str
    dims: int

    def embed(self, text: str, kind: str = "document") -> list[float]: ...


def tokenize(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in STOPWORDS and len(w) > 1]


def _bucket(token: str, dims: int) -> tuple[int, float]:
    h = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    n = int.from_bytes(h, "little")
    return n % dims, 1.0 if (n >> 63) & 1 else -1.0


class HashedEmbedder:
    name = "hashed-v1"

    def __init__(self, dims: int = 1024):
        self.dims = dims
        self.name = f"hashed-v1-{dims}"

    def embed(self, text: str, kind: str = "document") -> list[float]:
        vec = [0.0] * self.dims
        toks = tokenize(text)
        feats: list[str] = list(toks)
        feats.extend(f"{a}_{b}" for a, b in zip(toks, toks[1:]))
        counts: dict[str, int] = {}
        for f in feats:
            counts[f] = counts.get(f, 0) + 1
        for f, c in counts.items():
            i, s = _bucket(f, self.dims)
            vec[i] += s * (1.0 + math.log(c))
        return normalize(vec)


class LlamaEmbedder:
    def __init__(self, url: str, model: str = "", timeout: int = 60,
                 doc_prefix: str = "search_document: ", query_prefix: str = "search_query: "):
        self.url = url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.doc_prefix = doc_prefix
        self.query_prefix = query_prefix
        self.name = f"llama:{model or 'default'}"
        self.dims = 0

    def embed(self, text: str, kind: str = "document") -> list[float]:
        prefix = self.query_prefix if kind == "query" else self.doc_prefix
        body: dict = {"input": prefix + text}
        if self.model:
            body["model"] = self.model
        req = urllib.request.Request(
            self.url + "/embeddings", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            d = json.load(r)
        vec = d["data"][0]["embedding"]
        self.dims = len(vec)
        return normalize([float(x) for x in vec])


def normalize(vec: Sequence[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in vec))
    if n == 0.0:
        return list(vec)
    return [x / n for x in vec]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    if len(a) != len(b) or not a:
        return 0.0
    return sum(x * y for x, y in zip(a, b))


def pack(vec: Iterable[float]) -> bytes:
    return array.array("f", vec).tobytes()


def unpack(blob: bytes | None) -> list[float]:
    if not blob:
        return []
    a = array.array("f")
    a.frombytes(blob)
    return a.tolist()


def make_embedder(embed_url: str = "", embed_model: str = "", dims: int = 1024,
                  doc_prefix: str = "search_document: ", query_prefix: str = "search_query: ") -> Embedder:
    """Pick the llama backend when configured and reachable, else the hashed one."""
    if embed_url:
        emb = LlamaEmbedder(embed_url, embed_model, doc_prefix=doc_prefix, query_prefix=query_prefix)
        try:
            emb.embed("probe")
            return emb
        except Exception:
            pass
    return HashedEmbedder(dims)
