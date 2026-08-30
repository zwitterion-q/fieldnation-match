"""Central configuration. Feature weights here are the tuning surface for
relevance -- the whole point of a weighted centroid is that you can move a
single number and change how much a signal counts."""
import os

WO_DSN     = os.getenv("WO_DSN",   "postgresql://fn:fn@localhost:55432/workorders")
TECH_DSN   = os.getenv("TECH_DSN", "postgresql://fn:fn@localhost:55433/technicians")
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:56333")

EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
VECTOR_DIM  = 384

# Collections holding one weighted centroid per entity.
C_WORK_ORDERS = "work_orders"
C_TECHNICIANS = "technicians"

# One collection per taxonomy type. An extracted phrase is embedded and kNN'd
# against the matching collection to resolve it to a canonical attribute_id.
ATTRIBUTE_TYPES = ["skill", "experience", "experience_level",
                   "industry", "experience_type", "certification"]
def tax_collection(attr_type: str) -> str:
    return f"tax_{attr_type}"

# Weighted centroid composition. Must be interpreted relative to each other,
# not as absolutes -- they are renormalised over whichever features exist.
FEATURE_WEIGHTS = {
    "title":            0.28,
    "skill":            0.24,
    "experience_type":  0.14,
    "industry":         0.12,
    "experience":       0.10,
    "experience_level": 0.06,
    "certification":    0.04,
    "body":             0.02,
}

# Resolution + dedup thresholds.
TAXONOMY_MATCH_THRESHOLD = 0.50   # phrase -> nearest surface form of an attribute
DEDUPE_VECTOR_THRESHOLD  = 0.93   # near-identical, and scoped to same buyer+site
