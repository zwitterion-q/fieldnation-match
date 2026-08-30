"""Matching and explanation.

Ranking uses the weighted centroid: one kNN query in Qdrant returns the nearest
entities in the shared embedding space. Explanation is computed separately from
the resolved taxonomy ids, so every score can be broken down into which features
actually agreed. That separation is the point -- a single cosine number is not
something you can show a buyer or a technician.
"""
from __future__ import annotations
from collections import defaultdict

FEATURE_WEIGHTS = {
    "skill": 0.24, "experience_type": 0.14, "industry": 0.12,
    "experience": 0.10, "experience_level": 0.06, "certification": 0.04,
}
TYPE_LABEL = {
    "skill": "Skills", "experience": "Experience areas",
    "experience_level": "Seniority", "industry": "Industry",
    "experience_type": "Work type", "certification": "Certifications",
}


def explain(wo_attrs: list[dict], tech_attrs: list[dict]) -> dict:
    """wo_attrs / tech_attrs: [{'id','type','name'}, ...] -> per-feature breakdown."""
    wo_by, tech_by = defaultdict(dict), defaultdict(dict)
    for a in wo_attrs:
        wo_by[a["type"]][a["id"]] = a["name"]
    for a in tech_attrs:
        tech_by[a["type"]][a["id"]] = a["name"]

    breakdown, contributed = [], 0.0
    for atype in ("skill", "experience_type", "industry", "experience",
                  "experience_level", "certification"):
        required = wo_by.get(atype, {})
        if not required:
            continue
        held = tech_by.get(atype, {})
        matched_ids = set(required) & set(held)
        ratio = len(matched_ids) / len(required)
        weight = FEATURE_WEIGHTS.get(atype, 0.05)
        contributed += ratio * weight
        breakdown.append({
            "feature_type": atype,
            "label": TYPE_LABEL.get(atype, atype),
            "required": len(required),
            "matched": len(matched_ids),
            "coverage": round(ratio, 3),
            "weight": weight,
            "matched_names": [required[i] for i in matched_ids],
            "missing_names": [n for i, n in required.items() if i not in matched_ids],
        })

    total_weight = sum(b["weight"] for b in breakdown) or 1.0
    return {
        "breakdown": breakdown,
        "attribute_coverage": round(contributed / total_weight, 3),
    }


def blend(vector_score: float, coverage: float, alpha: float = 0.7) -> float:
    """Final rank = mostly the centroid similarity, nudged by explicit taxonomy
    overlap. Keeping them separate means a match is never unexplainable: if the
    vector likes it, the coverage tells you whether that agreement is real."""
    return round(alpha * vector_score + (1 - alpha) * coverage, 4)
