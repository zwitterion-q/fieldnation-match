"""Qdrant access: entity centroid collections plus one collection per taxonomy
type. The taxonomy collections are what turn a free-text phrase like
'pulled cat6 through ceiling' into attribute_id 3 (Structured Cabling)."""
from __future__ import annotations
import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import (Distance, VectorParams, PointStruct, Filter,
                                  FieldCondition, MatchValue)
from config import (QDRANT_URL, VECTOR_DIM, C_WORK_ORDERS, C_TECHNICIANS,
                    ATTRIBUTE_TYPES, tax_collection)


def client() -> QdrantClient:
    return QdrantClient(url=QDRANT_URL, timeout=60)


def ensure_collections(qc: QdrantClient) -> list[str]:
    """Idempotent. Entity collections plus tax_<type> for every attribute type."""
    wanted = [C_WORK_ORDERS, C_TECHNICIANS] + [tax_collection(t) for t in ATTRIBUTE_TYPES]
    existing = {c.name for c in qc.get_collections().collections}
    for name in wanted:
        if name not in existing:
            qc.create_collection(
                collection_name=name,
                vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
            )
    return wanted


def upsert(qc: QdrantClient, collection: str, points: list[PointStruct]) -> int:
    if not points:
        return 0
    for i in range(0, len(points), 256):
        qc.upsert(collection_name=collection, points=points[i:i + 256], wait=True)
    return len(points)


def point(pid: int, vector: np.ndarray, payload: dict) -> PointStruct:
    return PointStruct(id=pid, vector=vector.tolist(), payload=payload)


def knn(qc: QdrantClient, collection: str, vector: np.ndarray, limit: int = 10,
        payload_filter: Filter | None = None):
    return qc.query_points(collection_name=collection, query=vector.tolist(),
                           limit=limit, query_filter=payload_filter,
                           with_payload=True).points


def eq_filter(field: str, value) -> Filter:
    return Filter(must=[FieldCondition(key=field, match=MatchValue(value=value))])
