"""Embedding + weighted-centroid construction.

The centroid is the core idea carried over from the CareerOne matching engine:
every normalised feature is embedded on its own, then the features are combined
by weight into ONE vector per entity. Because each feature also stays indexed in
its taxonomy collection, a match can be explained feature by feature instead of
collapsing into a single opaque score.
"""
from __future__ import annotations
import numpy as np
from functools import lru_cache
from sentence_transformers import SentenceTransformer
from config import EMBED_MODEL, VECTOR_DIM, FEATURE_WEIGHTS


@lru_cache(maxsize=1)
def _model() -> SentenceTransformer:
    return SentenceTransformer(EMBED_MODEL)


def embed(texts: list[str]) -> np.ndarray:
    """Encode to L2-normalised vectors so dot product == cosine similarity."""
    if not texts:
        return np.zeros((0, VECTOR_DIM), dtype=np.float32)
    return _model().encode(texts, normalize_embeddings=True,
                           convert_to_numpy=True, show_progress_bar=False).astype(np.float32)


def embed_one(text: str) -> np.ndarray:
    return embed([text])[0]


def weighted_centroid(features: list[tuple[str, str]]) -> tuple[np.ndarray, int]:
    """features: [(feature_type, feature_text), ...] -> (centroid, n_vectors).

    Each feature contributes its own vector. Weights come from FEATURE_WEIGHTS
    and are renormalised across whatever features this entity actually has, so
    an entity missing an industry is not penalised into a different region of
    the space -- its remaining signals simply carry proportionally more.
    """
    if not features:
        return np.zeros(VECTOR_DIM, dtype=np.float32), 0

    texts   = [t for _, t in features]
    vecs    = embed(texts)
    weights = np.array([FEATURE_WEIGHTS.get(ft, 0.05) for ft, _ in features], dtype=np.float32)
    weights = weights / weights.sum()

    centroid = (vecs * weights[:, None]).sum(axis=0)
    norm = np.linalg.norm(centroid)
    if norm > 0:
        centroid = centroid / norm
    return centroid.astype(np.float32), len(vecs)
