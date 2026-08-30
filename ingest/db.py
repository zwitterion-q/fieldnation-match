"""Thin psycopg helpers plus taxonomy seeding into both databases."""
from __future__ import annotations
import os, json, psycopg
from pathlib import Path
from config import WO_DSN, TECH_DSN

_here = Path(__file__).parent
TAXONOMY_FILE = Path(os.getenv(
    "TAXONOMY_PATH",
    _here / "taxonomy" / "taxonomy.json" if (_here / "taxonomy" / "taxonomy.json").exists()
    else _here.parent / "taxonomy" / "taxonomy.json"))


def wo_conn():   return psycopg.connect(WO_DSN,   autocommit=False)
def tech_conn(): return psycopg.connect(TECH_DSN, autocommit=False)


def load_taxonomy() -> list[dict]:
    return json.loads(TAXONOMY_FILE.read_text())


def seed_taxonomy() -> list[dict]:
    """Insert the taxonomy into the work-order DB (authoritative, assigns ids)
    then replicate the same ids into the technician DB. Separate databases owned
    by separate services, one shared vocabulary."""
    tax = load_taxonomy()
    with wo_conn() as c, c.cursor() as cur:
        for t in tax:
            cur.execute(
                """INSERT INTO core_job_attributes (attribute_type, slug, canonical_name, description)
                   VALUES (%s,%s,%s,%s)
                   ON CONFLICT (attribute_type, slug) DO UPDATE SET canonical_name=EXCLUDED.canonical_name
                   RETURNING attribute_id""",
                (t["attribute_type"], t["slug"], t["canonical_name"], t.get("description", "")))
            t["attribute_id"] = cur.fetchone()[0]
            for alias in t["aliases"] + [t["canonical_name"]]:
                cur.execute(
                    "INSERT INTO attribute_aliases (attribute_id, alias) VALUES (%s,%s) "
                    "ON CONFLICT DO NOTHING", (t["attribute_id"], alias.lower()))
        c.commit()

    with tech_conn() as c, c.cursor() as cur:
        for t in tax:
            cur.execute(
                """INSERT INTO core_job_attributes (attribute_id, attribute_type, slug, canonical_name, description)
                   VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT (attribute_id) DO UPDATE SET canonical_name=EXCLUDED.canonical_name""",
                (t["attribute_id"], t["attribute_type"], t["slug"],
                 t["canonical_name"], t.get("description", "")))
        c.commit()
    return tax


def alias_index() -> dict[str, list[tuple[int, str, str]]]:
    """phrase -> [(attribute_id, attribute_type, canonical_name)]"""
    idx: dict[str, list] = {}
    with wo_conn() as c, c.cursor() as cur:
        cur.execute("""SELECT lower(al.alias), a.attribute_id, a.attribute_type, a.canonical_name
                       FROM attribute_aliases al
                       JOIN core_job_attributes a ON a.attribute_id = al.attribute_id""")
        for alias, aid, atype, canon in cur.fetchall():
            idx.setdefault(alias, []).append((aid, atype, canon))
    return idx
