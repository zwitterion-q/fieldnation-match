"""Resolve an extracted phrase to a canonical attribute_id.

Two layers, cheapest first:

  1. Alias lookup  -- exact match against attribute_aliases. Free, no embedding.
  2. Taxonomy kNN  -- embed the phrase and search the tax_<type> collection in
                      Qdrant, accepting the nearest canonical attribute above a
                      similarity threshold.

Layer 2 is why the taxonomy lives in its own vector collections: an unseen
phrase like "pulled cat6 above the ceiling grid" still lands on
Structured Cabling without anyone adding an alias for it.
"""
from __future__ import annotations
from dataclasses import dataclass
from embedding import embed_one
from vectorstore import knn, client as qclient
from config import tax_collection, TAXONOMY_MATCH_THRESHOLD


@dataclass
class Resolution:
    attribute_id: int
    attribute_type: str
    canonical_name: str
    raw_value: str
    confidence: float
    resolved_by: str          # alias | vector_knn


class TaxonomyResolver:
    def __init__(self, alias_index: dict, qc=None):
        self.alias_index = alias_index          # phrase -> [(id, type, canonical)]
        self.qc = qc or qclient()
        self._miss_cache: dict[tuple[str, str], Resolution | None] = {}

    def resolve(self, attr_type: str, phrase: str) -> Resolution | None:
        p = (phrase or "").strip().lower()
        if not p:
            return None

        # 1. exact alias / canonical-name hit
        for aid, atype, canon in self.alias_index.get(p, []):
            if atype == attr_type:
                return Resolution(aid, atype, canon, phrase, 1.0, "alias")

        # 2. vector kNN against this type's taxonomy collection
        key = (attr_type, p)
        if key in self._miss_cache:
            return self._miss_cache[key]
        try:
            hits = knn(self.qc, tax_collection(attr_type), embed_one(p), limit=1)
        except Exception:
            hits = []
        res = None
        if hits and hits[0].score >= TAXONOMY_MATCH_THRESHOLD:
            pl = hits[0].payload
            res = Resolution(pl["attribute_id"], attr_type, pl["canonical_name"],
                             phrase, float(hits[0].score), "vector_knn")
        self._miss_cache[key] = res
        return res

    def resolve_all(self, pairs: list[tuple[str, str]]) -> list[Resolution]:
        out, seen = [], set()
        for atype, phrase in pairs:
            r = self.resolve(atype, phrase)
            if r and r.attribute_id not in seen:
                seen.add(r.attribute_id)
                out.append(r)
        return out
