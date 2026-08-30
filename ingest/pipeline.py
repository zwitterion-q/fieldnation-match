"""End-to-end ingestion.

    fetch -> clean -> hash-dedupe -> extract -> resolve to taxonomy ids
          -> persist features -> weighted centroid -> vector-dedupe -> index

Run:
    python -m pipeline --all
    python -m pipeline --taxonomy --workorders --technicians
"""
from __future__ import annotations
import argparse, sys, time
import numpy as np

from config import (C_WORK_ORDERS, C_TECHNICIANS, VECTOR_DIM, tax_collection,
                    FEATURE_WEIGHTS)
from db import seed_taxonomy, alias_index, wo_conn, tech_conn
from cleaning import strip_html, content_hash
from embedding import embed, embed_one, weighted_centroid
from vectorstore import client as qclient, ensure_collections, upsert, point
from extraction import build_extractor
from resolver import TaxonomyResolver
import dedupe as dd
from sources.live_apis import fetch_arbeitnow, fetch_remotive, fetch_jobicy, fetch_adzuna
from sources.synthetic import fetch_synthetic
import technicians_gen


def log(msg): print(msg, flush=True)


# ---------------------------------------------------------------- taxonomy ---
def index_taxonomy(qc, tax):
    """One Qdrant collection per attribute type. These are what an unseen phrase
    is kNN'd against to reach a canonical id."""
    by_type: dict[str, list] = {}
    for t in tax:
        by_type.setdefault(t["attribute_type"], []).append(t)
    total = 0
    for atype, items in by_type.items():
        # One vector PER SURFACE FORM, not one per attribute. Collapsing a label
        # and its aliases into a single blob pushes the vector toward an average
        # that matches none of them well -- a colloquial phrase like "ran cat6
        # above the ceiling grid" then scores poorly against everything. Indexing
        # each alias separately lets the phrase match the surface form people
        # actually write, and every form carries the same attribute_id home.
        texts, payloads = [], []
        for it in items:
            forms = [it["canonical_name"]] + it["aliases"]
            for k, form in enumerate(forms):
                texts.append(form)
                payloads.append({"attribute_id": it["attribute_id"],
                                 "attribute_type": atype,
                                 "canonical_name": it["canonical_name"],
                                 "slug": it["slug"], "surface_form": form,
                                 "point_id": it["attribute_id"] * 1000 + k})
        vecs = embed(texts)
        pts = [point(pl["point_id"], v, pl) for pl, v in zip(payloads, vecs)]
        total += upsert(qc, tax_collection(atype), pts)
        log(f"    {tax_collection(atype):26s} {len(items):3d} attributes / {len(pts):4d} surface forms")
    return total


# ------------------------------------------------------------- work orders ---
def ingest_work_orders(qc, extractor, resolver, target=200):
    raws = []
    log("  fetching sources...")
    for fn in (fetch_arbeitnow, fetch_remotive, fetch_jobicy, fetch_adzuna):
        got = fn()
        if got:
            log(f"    {got[0].source:24s} {len(got):3d} jobs")
        raws.extend(got)
    live_count = len(raws)
    syn = fetch_synthetic(count=max(target - live_count, 120))
    log(f"    {'fieldnation_synthetic':24s} {len(syn):3d} work orders")
    raws.extend(syn)

    stats = dict(fetched=len(raws), inserted=0, dup_hash=0, dup_vector=0, indexed=0)
    with wo_conn() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO ingestion_runs (source) VALUES ('pipeline') RETURNING run_id")
        run_id = cur.fetchone()[0]
        conn.commit()

        for i, raw in enumerate(raws, 1):
            body_clean = strip_html(raw.body_raw)
            if len(body_clean) < 40:
                continue
            chash = content_hash(raw.title, body_clean)

            if dd.hash_duplicate(cur, chash):
                stats["dup_hash"] += 1
                continue

            cur.execute(
                """INSERT INTO work_orders
                   (external_id, source, source_type, source_url, title, company,
                    body_raw, body_clean, city, state, country, latitude, longitude,
                    pay_type, pay_rate, duration_hours, posted_at, content_hash, run_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (source, external_id) DO NOTHING
                   RETURNING work_order_id""",
                (raw.external_id, raw.source, raw.source_type, raw.source_url,
                 raw.title[:500], raw.company, raw.body_raw, body_clean,
                 raw.city, raw.state, raw.country,
                 getattr(raw, "latitude", None), getattr(raw, "longitude", None),
                 raw.pay_type, raw.pay_rate, raw.duration_hours, raw.posted_at,
                 chash, run_id))
            row = cur.fetchone()
            if not row:
                stats["dup_hash"] += 1
                continue
            wo_id = row[0]
            stats["inserted"] += 1

            feats = extractor.extract(raw.title, body_clean)
            resolutions = resolver.resolve_all(feats.as_pairs())

            pairs = [("title", feats.title), ("body", body_clean[:600])]
            for r in resolutions:
                pairs.append((r.attribute_type, r.canonical_name))
                cur.execute(
                    """INSERT INTO work_order_attributes
                       (work_order_id, attribute_id, raw_value, confidence, resolved_by)
                       VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (wo_id, r.attribute_id, r.raw_value, r.confidence, r.resolved_by))
            for ftype, ftext in pairs:
                cur.execute(
                    """INSERT INTO work_order_features (work_order_id, feature_type, feature_text, weight)
                       VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (wo_id, ftype, ftext[:1000], FEATURE_WEIGHTS.get(ftype, 0.05)))

            centroid, nvec = weighted_centroid(pairs)

            hit = dd.vector_duplicate(qc, centroid, raw.company, raw.city)
            if hit:
                dup_of, score = hit
                dd.record(cur, wo_id, dup_of, "vector_knn", score)
                stats["dup_vector"] += 1
                conn.commit()
                continue

            upsert(qc, C_WORK_ORDERS, [point(wo_id, centroid, {
                "work_order_id": wo_id, "title": feats.title, "company": raw.company,
                "city": raw.city, "state": raw.state, "source": raw.source,
                "source_type": raw.source_type, "pay_rate": float(raw.pay_rate or 0),
                "attribute_ids": [r.attribute_id for r in resolutions],
                "skills": [r.canonical_name for r in resolutions if r.attribute_type == "skill"],
            })])
            cur.execute(
                """INSERT INTO vector_index_state (work_order_id, collection, vector_dim, n_feature_vecs)
                   VALUES (%s,%s,%s,%s) ON CONFLICT (work_order_id) DO NOTHING""",
                (wo_id, C_WORK_ORDERS, VECTOR_DIM, nvec))
            stats["indexed"] += 1
            conn.commit()
            if i % 40 == 0:
                log(f"    ...{i}/{len(raws)} processed")

        cur.execute(
            """UPDATE ingestion_runs SET finished_at=now(), fetched=%s, inserted=%s,
               duplicates=%s, normalised=%s, indexed=%s WHERE run_id=%s""",
            (stats["fetched"], stats["inserted"], stats["dup_hash"] + stats["dup_vector"],
             stats["inserted"], stats["indexed"], run_id))
        conn.commit()
    return stats


# -------------------------------------------------------------- technicians --
def ingest_technicians(qc, resolver, count=60):
    techs = technicians_gen.generate(count)
    n_idx = 0
    with tech_conn() as conn, conn.cursor() as cur:
        for t in techs:
            cur.execute(
                """INSERT INTO technicians
                   (external_id, full_name, headline, bio, city, state, latitude, longitude,
                    travel_radius_mi, hourly_rate, rating, jobs_completed, years_experience)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (external_id) DO NOTHING RETURNING technician_id""",
                (t.external_id, t.full_name, t.headline, t.bio, t.city, t.state,
                 t.latitude, t.longitude, t.travel_radius_mi, t.hourly_rate,
                 t.rating, t.jobs_completed, t.years_experience))
            row = cur.fetchone()
            if not row:
                continue
            tid = row[0]

            feats = t.features()
            pairs_for_resolution = [(ft, tx) for ft, tx in feats
                                    if ft not in ("title", "body")]
            for r in resolver.resolve_all(pairs_for_resolution):
                cur.execute(
                    """INSERT INTO technician_attributes (technician_id, attribute_id, years, proficiency)
                       VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (tid, r.attribute_id, t.years_experience,
                     "expert" if t.years_experience > 8 else
                     "proficient" if t.years_experience > 3 else "familiar"))
            for ftype, ftext in feats:
                cur.execute(
                    """INSERT INTO technician_features (technician_id, feature_type, feature_text, weight)
                       VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (tid, ftype, ftext[:1000], FEATURE_WEIGHTS.get(ftype, 0.05)))

            centroid, nvec = weighted_centroid(feats)
            upsert(qc, C_TECHNICIANS, [point(tid, centroid, {
                "technician_id": tid, "full_name": t.full_name, "headline": t.headline,
                "city": t.city, "state": t.state, "hourly_rate": float(t.hourly_rate),
                "rating": float(t.rating), "level": t.level, "skills": t.skills,
            })])
            cur.execute(
                """INSERT INTO vector_index_state (technician_id, collection, vector_dim, n_feature_vecs)
                   VALUES (%s,%s,%s,%s) ON CONFLICT (technician_id) DO NOTHING""",
                (tid, C_TECHNICIANS, VECTOR_DIM, nvec))
            n_idx += 1
        conn.commit()
    return n_idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--taxonomy", action="store_true")
    ap.add_argument("--workorders", action="store_true")
    ap.add_argument("--technicians", action="store_true")
    ap.add_argument("--target", type=int, default=200)
    ap.add_argument("--techs", type=int, default=60)
    a = ap.parse_args()
    if a.all:
        a.taxonomy = a.workorders = a.technicians = True
    if not any([a.taxonomy, a.workorders, a.technicians]):
        ap.error("nothing to do -- pass --all or a stage flag")

    t0 = time.time()
    qc = qclient()
    log("[0/3] ensuring Qdrant collections")
    for c in ensure_collections(qc):
        log(f"    {c}")

    tax = seed_taxonomy()
    idx = alias_index()
    log(f"[1/3] taxonomy: {len(tax)} attributes, {len(idx)} alias phrases")
    if a.taxonomy:
        index_taxonomy(qc, tax)

    resolver  = TaxonomyResolver(idx, qc)
    extractor = build_extractor(idx)
    log(f"      extractor: {extractor.name}")

    if a.workorders:
        log("[2/3] work orders")
        s = ingest_work_orders(qc, extractor, resolver, a.target)
        log(f"      fetched={s['fetched']} inserted={s['inserted']} "
            f"hash-dupes={s['dup_hash']} vector-dupes={s['dup_vector']} indexed={s['indexed']}")

    if a.technicians:
        log("[3/3] technicians")
        n = ingest_technicians(qc, resolver, a.techs)
        log(f"      indexed {n} technicians")

    log(f"done in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
