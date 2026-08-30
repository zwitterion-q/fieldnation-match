"""Two-layer duplicate detection, matching the CareerOne approach.

  Layer 1 -- content hash. Catches byte-identical reposts for free.
  Layer 2 -- vector kNN. Catches the same work order reworded across channels,
             which hashing cannot see. This is the layer that matters in a
             marketplace, where one buyer posts the same job to several sources.
"""
from __future__ import annotations
import numpy as np
from qdrant_client.models import Filter, FieldCondition, MatchValue
from vectorstore import knn
from config import C_WORK_ORDERS, DEDUPE_VECTOR_THRESHOLD


def hash_duplicate(cur, content_hash: str) -> int | None:
    cur.execute(
        "SELECT work_order_id FROM work_orders WHERE content_hash = %s "
        "AND status <> 'duplicate' LIMIT 1", (content_hash,))
    row = cur.fetchone()
    return row[0] if row else None


def vector_duplicate(qc, vector: np.ndarray, company: str | None, city: str | None,
                     threshold: float = DEDUPE_VECTOR_THRESHOLD) -> tuple[int, float] | None:
    """Nearest already-indexed work order that is *also* the same buyer at the
    same site.

    Semantic similarity on its own is not duplication. Two POS installs for two
    different retailers in two different cities are legitimately near-identical
    in feature space and are still two separate jobs someone has to drive to.
    A duplicate is the same buyer posting the same site work twice -- typically
    across channels -- so the vector search is scoped to that.
    """
    flt = None
    if company and city:
        flt = Filter(must=[
            FieldCondition(key="company", match=MatchValue(value=company)),
            FieldCondition(key="city",    match=MatchValue(value=city)),
        ])
    try:
        hits = knn(qc, C_WORK_ORDERS, vector, limit=1, payload_filter=flt)
    except Exception:
        return None
    if hits and hits[0].score >= threshold:
        return int(hits[0].id), float(hits[0].score)
    return None


def record(cur, work_order_id: int, duplicate_of: int, method: str, score: float | None):
    cur.execute(
        "INSERT INTO dedupe_links (work_order_id, duplicate_of, method, score) "
        "VALUES (%s,%s,%s,%s)", (work_order_id, duplicate_of, method, score))
    cur.execute("UPDATE work_orders SET status='duplicate' WHERE work_order_id=%s",
                (work_order_id,))
