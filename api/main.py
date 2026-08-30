"""Field Nation matching API.

Serves both surfaces from one shared embedding space:
  * the buyer web app  -- work orders, and the technicians who fit each one
  * the technician app -- work orders ranked for a given technician
"""
from __future__ import annotations
import os
from functools import lru_cache
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from qdrant_client import QdrantClient
from sentence_transformers import SentenceTransformer

import matching

WO_DSN     = os.getenv("WO_DSN",   "postgresql://fn:fn@localhost:55432/workorders")
TECH_DSN   = os.getenv("TECH_DSN", "postgresql://fn:fn@localhost:55433/technicians")
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:56333")
C_WO, C_TECH = "work_orders", "technicians"

app = FastAPI(title="Field Nation Matching API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@lru_cache(maxsize=1)
def model() -> SentenceTransformer:
    return SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")


def qc() -> QdrantClient:
    return QdrantClient(url=QDRANT_URL, timeout=30)


@contextmanager
def db(dsn: str):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        yield conn


def _attrs(conn, table: str, key: str, ident: int) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(f"""SELECT a.attribute_id AS id, a.attribute_type AS type,
                               a.canonical_name AS name
                        FROM {table} x
                        JOIN core_job_attributes a ON a.attribute_id = x.attribute_id
                        WHERE x.{key} = %s""", (ident,))
        return cur.fetchall()


# ------------------------------------------------------------------ health ---
@app.get("/health")
def health():
    out = {"api": "ok"}
    try:
        with db(WO_DSN) as c, c.cursor() as cur:
            cur.execute("SELECT count(*) n FROM work_orders WHERE status='open'")
            out["work_orders_open"] = cur.fetchone()["n"]
    except Exception as e:
        out["workorders_db"] = f"error: {e}"
    try:
        with db(TECH_DSN) as c, c.cursor() as cur:
            cur.execute("SELECT count(*) n FROM technicians")
            out["technicians"] = cur.fetchone()["n"]
    except Exception as e:
        out["technicians_db"] = f"error: {e}"
    try:
        out["collections"] = sorted(c.name for c in qc().get_collections().collections)
    except Exception as e:
        out["qdrant"] = f"error: {e}"
    return out


@app.get("/stats")
def stats():
    """Pipeline provenance -- what came from live APIs vs generated, and how
    many duplicates each dedup layer caught."""
    with db(WO_DSN) as c, c.cursor() as cur:
        cur.execute("""SELECT source, source_type, count(*) n,
                              count(*) FILTER (WHERE status='duplicate') dupes
                       FROM work_orders GROUP BY source, source_type ORDER BY n DESC""")
        by_source = cur.fetchall()
        cur.execute("SELECT method, count(*) n, round(avg(score)::numeric,4) avg_score "
                    "FROM dedupe_links GROUP BY method")
        dedupe = cur.fetchall()
        cur.execute("SELECT attribute_type, count(*) n FROM core_job_attributes "
                    "GROUP BY attribute_type ORDER BY n DESC")
        taxonomy = cur.fetchall()
        cur.execute("""SELECT resolved_by, count(*) n FROM work_order_attributes
                       GROUP BY resolved_by""")
        resolution = cur.fetchall()
        cur.execute("SELECT count(*) n, coalesce(sum(n_feature_vecs),0) v FROM vector_index_state")
        idx = cur.fetchone()
    with db(TECH_DSN) as c, c.cursor() as cur:
        cur.execute("SELECT count(*) n, coalesce(sum(n_feature_vecs),0) v FROM vector_index_state")
        tidx = cur.fetchone()
    return {"work_orders_by_source": by_source, "dedupe": dedupe,
            "taxonomy": taxonomy, "attribute_resolution": resolution,
            "indexed_work_orders": idx["n"], "work_order_feature_vectors": idx["v"],
            "indexed_technicians": tidx["n"], "technician_feature_vectors": tidx["v"]}


# ------------------------------------------------------------- work orders ---
@app.get("/work-orders")
def list_work_orders(q: str | None = None, state: str | None = None,
                     skill: str | None = None, limit: int = Query(40, le=200), offset: int = 0):
    where, params = ["w.status = 'open'"], []
    if q:
        where.append("(w.title ILIKE %s OR w.company ILIKE %s)"); params += [f"%{q}%", f"%{q}%"]
    if state:
        where.append("w.state = %s"); params.append(state)
    if skill:
        where.append("""EXISTS (SELECT 1 FROM work_order_attributes wa
                                JOIN core_job_attributes a ON a.attribute_id=wa.attribute_id
                                WHERE wa.work_order_id=w.work_order_id
                                  AND a.attribute_type='skill' AND a.canonical_name=%s)""")
        params.append(skill)
    sql = f"""SELECT w.work_order_id, w.title, w.company, w.city, w.state, w.source,
                     w.source_type, w.pay_type, w.pay_rate, w.duration_hours, w.posted_at,
                     w.ingested_at,
                     (SELECT count(*) FROM work_order_attributes wa WHERE wa.work_order_id=w.work_order_id) n_attrs
              FROM work_orders w WHERE {' AND '.join(where)}
              ORDER BY w.ingested_at DESC, w.work_order_id DESC LIMIT %s OFFSET %s"""
    with db(WO_DSN) as c, c.cursor() as cur:
        cur.execute(sql, params + [limit, offset]); rows = cur.fetchall()
        cur.execute(f"SELECT count(*) n FROM work_orders w WHERE {' AND '.join(where)}", params)
        total = cur.fetchone()["n"]
    return {"total": total, "limit": limit, "offset": offset, "items": rows}


@app.get("/work-orders/{wo_id}")
def get_work_order(wo_id: int):
    with db(WO_DSN) as c:
        with c.cursor() as cur:
            cur.execute("SELECT * FROM work_orders WHERE work_order_id=%s", (wo_id,))
            wo = cur.fetchone()
            if not wo:
                raise HTTPException(404, "work order not found")
            cur.execute("""SELECT feature_type, feature_text, weight FROM work_order_features
                           WHERE work_order_id=%s ORDER BY weight DESC""", (wo_id,))
            wo["features"] = cur.fetchall()
            cur.execute("""SELECT a.attribute_id id, a.attribute_type type, a.canonical_name name,
                                  wa.raw_value, wa.confidence, wa.resolved_by
                           FROM work_order_attributes wa
                           JOIN core_job_attributes a ON a.attribute_id=wa.attribute_id
                           WHERE wa.work_order_id=%s ORDER BY a.attribute_type""", (wo_id,))
            wo["attributes"] = cur.fetchall()
    wo.pop("body_raw", None)
    return wo


@app.get("/work-orders/{wo_id}/matches")
def match_technicians(wo_id: int, limit: int = Query(10, le=50)):
    """Buyer side: who should do this job."""
    with db(WO_DSN) as c:
        wo_attrs = _attrs(c, "work_order_attributes", "work_order_id", wo_id)
        with c.cursor() as cur:
            cur.execute("SELECT title, city, state FROM work_orders WHERE work_order_id=%s", (wo_id,))
            wo = cur.fetchone()
    if not wo:
        raise HTTPException(404, "work order not found")

    pts = qc().retrieve(collection_name=C_WO, ids=[wo_id], with_vectors=True)
    if not pts:
        raise HTTPException(409, "work order is not indexed (it may be a duplicate)")
    hits = qc().query_points(collection_name=C_TECH, query=pts[0].vector,
                             limit=limit, with_payload=True).points

    results = []
    with db(TECH_DSN) as tc:
        for h in hits:
            tid = int(h.id)
            t_attrs = _attrs(tc, "technician_attributes", "technician_id", tid)
            ex = matching.explain(wo_attrs, t_attrs)
            with tc.cursor() as cur:
                cur.execute("""SELECT technician_id, full_name, headline, city, state,
                                      hourly_rate, rating, jobs_completed, years_experience
                               FROM technicians WHERE technician_id=%s""", (tid,))
                t = cur.fetchone()
            if not t:
                continue
            t.update(vector_score=round(float(h.score), 4),
                     match_score=matching.blend(float(h.score), ex["attribute_coverage"]),
                     **ex)
            results.append(t)
    results.sort(key=lambda r: r["match_score"], reverse=True)
    return {"work_order": {"id": wo_id, **wo}, "matches": results}


# ------------------------------------------------------------- technicians ---
@app.get("/technicians")
def list_technicians(limit: int = Query(60, le=200), offset: int = 0):
    with db(TECH_DSN) as c, c.cursor() as cur:
        cur.execute("""SELECT technician_id, external_id, full_name, headline, city, state,
                              hourly_rate, rating, jobs_completed, years_experience
                       FROM technicians ORDER BY rating DESC, jobs_completed DESC
                       LIMIT %s OFFSET %s""", (limit, offset))
        rows = cur.fetchall()
        cur.execute("SELECT count(*) n FROM technicians")
        total = cur.fetchone()["n"]
    return {"total": total, "items": rows}


@app.get("/technicians/{tech_id}")
def get_technician(tech_id: int):
    with db(TECH_DSN) as c, c.cursor() as cur:
        cur.execute("SELECT * FROM technicians WHERE technician_id=%s", (tech_id,))
        t = cur.fetchone()
        if not t:
            raise HTTPException(404, "technician not found")
        cur.execute("""SELECT a.attribute_id id, a.attribute_type type, a.canonical_name name,
                              ta.years, ta.proficiency
                       FROM technician_attributes ta
                       JOIN core_job_attributes a ON a.attribute_id=ta.attribute_id
                       WHERE ta.technician_id=%s ORDER BY a.attribute_type""", (tech_id,))
        t["attributes"] = cur.fetchall()
    return t


@app.get("/technicians/{tech_id}/matches")
def match_work_orders(tech_id: int, limit: int = Query(20, le=50)):
    """Technician side: which jobs suit me. Same vectors, queried the other way."""
    with db(TECH_DSN) as c:
        t_attrs = _attrs(c, "technician_attributes", "technician_id", tech_id)
        with c.cursor() as cur:
            cur.execute("SELECT full_name, headline, city, state FROM technicians WHERE technician_id=%s",
                        (tech_id,))
            t = cur.fetchone()
    if not t:
        raise HTTPException(404, "technician not found")

    pts = qc().retrieve(collection_name=C_TECH, ids=[tech_id], with_vectors=True)
    if not pts:
        raise HTTPException(409, "technician is not indexed")
    hits = qc().query_points(collection_name=C_WO, query=pts[0].vector,
                             limit=limit, with_payload=True).points

    results = []
    with db(WO_DSN) as wc:
        for h in hits:
            wid = int(h.id)
            wo_attrs = _attrs(wc, "work_order_attributes", "work_order_id", wid)
            ex = matching.explain(wo_attrs, t_attrs)
            with wc.cursor() as cur:
                cur.execute("""SELECT work_order_id, title, company, city, state, source_type,
                                      pay_type, pay_rate, duration_hours
                               FROM work_orders WHERE work_order_id=%s AND status='open'""", (wid,))
                w = cur.fetchone()
            if not w:
                continue
            w.update(vector_score=round(float(h.score), 4),
                     match_score=matching.blend(float(h.score), ex["attribute_coverage"]),
                     **ex)
            results.append(w)
    results.sort(key=lambda r: r["match_score"], reverse=True)
    return {"technician": {"id": tech_id, **t}, "matches": results}


# ------------------------------------------------- live taxonomy resolution --
@app.get("/resolve")
def resolve(q: str, attribute_type: str = "skill", limit: int = 12):
    """Type any phrase and watch it resolve to canonical taxonomy ids.

    This is the normalisation step exposed directly: the phrase is embedded and
    kNN'd against that type's taxonomy collection. It is how free text like
    'ran cat6 above the ceiling grid' becomes Structured Cabling.
    """
    vec = model().encode([q], normalize_embeddings=True)[0].tolist()
    try:
        hits = qc().query_points(collection_name=f"tax_{attribute_type}", query=vec,
                                 limit=limit, with_payload=True).points
    except Exception as e:
        raise HTTPException(400, f"unknown attribute_type '{attribute_type}': {e}")
    # Several surface forms of one attribute can rank together; collapse to the
    # best-scoring form per attribute so the caller sees distinct attributes.
    best: dict[int, dict] = {}
    for h in hits:
        aid = h.payload["attribute_id"]
        if aid not in best or h.score > best[aid]["score"]:
            best[aid] = {"attribute_id": aid,
                         "canonical_name": h.payload["canonical_name"],
                         "slug": h.payload["slug"],
                         "matched_form": h.payload.get("surface_form"),
                         "score": round(float(h.score), 4)}
    return {"query": q, "attribute_type": attribute_type,
            "matches": sorted(best.values(), key=lambda m: -m["score"])}


@app.get("/taxonomy")
def taxonomy():
    with db(WO_DSN) as c, c.cursor() as cur:
        cur.execute("""SELECT a.attribute_id, a.attribute_type, a.slug, a.canonical_name,
                              count(wa.work_order_id) AS used_by
                       FROM core_job_attributes a
                       LEFT JOIN work_order_attributes wa ON wa.attribute_id=a.attribute_id
                       GROUP BY a.attribute_id ORDER BY a.attribute_type, used_by DESC""")
        return {"attributes": cur.fetchall()}
