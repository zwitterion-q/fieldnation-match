-- ===========================================================================
-- Work-order side. Mirrors the CareerOne model: raw ingest -> cleaned ->
-- normalised features -> features resolved to canonical taxonomy IDs.
-- ===========================================================================

-- The canonical taxonomy. Every normalised feature resolves to a row here.
-- attribute_type is what distinguishes a skill from an industry from a
-- seniority band, so one table backs every taxonomy vector collection.
CREATE TABLE core_job_attributes (
    attribute_id    SERIAL PRIMARY KEY,
    attribute_type  TEXT NOT NULL CHECK (attribute_type IN
                      ('skill','experience','experience_level','industry',
                       'experience_type','certification')),
    slug            TEXT NOT NULL,
    canonical_name  TEXT NOT NULL,
    description     TEXT,
    UNIQUE (attribute_type, slug)
);
CREATE INDEX idx_cja_type ON core_job_attributes(attribute_type);

-- Surface forms that map onto a canonical attribute. Cheap exact-match layer
-- that runs before the vector resolver, so obvious hits never cost an embed.
CREATE TABLE attribute_aliases (
    alias_id      SERIAL PRIMARY KEY,
    attribute_id  INT NOT NULL REFERENCES core_job_attributes(attribute_id) ON DELETE CASCADE,
    alias         TEXT NOT NULL,
    UNIQUE (attribute_id, alias)
);
CREATE INDEX idx_alias_lower ON attribute_aliases(lower(alias));

CREATE TABLE ingestion_runs (
    run_id       SERIAL PRIMARY KEY,
    source       TEXT NOT NULL,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    fetched      INT DEFAULT 0,
    inserted     INT DEFAULT 0,
    duplicates   INT DEFAULT 0,
    normalised   INT DEFAULT 0,
    indexed      INT DEFAULT 0,
    notes        TEXT
);

-- A work order. body_raw keeps the source HTML; body_clean is what we index.
CREATE TABLE work_orders (
    work_order_id  SERIAL PRIMARY KEY,
    external_id    TEXT NOT NULL,
    source         TEXT NOT NULL,
    source_type    TEXT NOT NULL CHECK (source_type IN ('live_api','synthetic')),
    source_url     TEXT,
    title          TEXT NOT NULL,
    company        TEXT,
    body_raw       TEXT,
    body_clean     TEXT,
    city           TEXT,
    state          TEXT,
    country        TEXT DEFAULT 'US',
    latitude       DOUBLE PRECISION,
    longitude      DOUBLE PRECISION,
    pay_type       TEXT CHECK (pay_type IN ('hourly','fixed','device','blended')),
    pay_rate       NUMERIC(10,2),
    currency       TEXT DEFAULT 'USD',
    duration_hours NUMERIC(6,2),
    scheduled_for  TIMESTAMPTZ,
    posted_at      TIMESTAMPTZ,
    ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    content_hash   TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','assigned','duplicate','closed')),
    run_id         INT REFERENCES ingestion_runs(run_id),
    UNIQUE (source, external_id)
);
CREATE INDEX idx_wo_hash   ON work_orders(content_hash);
CREATE INDEX idx_wo_status ON work_orders(status);
CREATE INDEX idx_wo_geo    ON work_orders(state, city);

-- Why a given work order was judged a duplicate, and by which layer.
CREATE TABLE dedupe_links (
    dedupe_id     SERIAL PRIMARY KEY,
    work_order_id INT NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
    duplicate_of  INT NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
    method        TEXT NOT NULL CHECK (method IN ('content_hash','vector_knn')),
    score         DOUBLE PRECISION,
    detected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The normalised feature set. One row per (work order, feature type) — this is
-- the structured half of the LLM pass. weight drives the centroid.
CREATE TABLE work_order_features (
    feature_id     SERIAL PRIMARY KEY,
    work_order_id  INT NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
    feature_type   TEXT NOT NULL,
    feature_text   TEXT NOT NULL,
    weight         DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    UNIQUE (work_order_id, feature_type, feature_text)
);
CREATE INDEX idx_wof_wo ON work_order_features(work_order_id);

-- Extracted values resolved to canonical taxonomy IDs. resolved_by records
-- whether the alias table or the taxonomy kNN made the call.
CREATE TABLE work_order_attributes (
    work_order_id  INT NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
    attribute_id   INT NOT NULL REFERENCES core_job_attributes(attribute_id),
    raw_value      TEXT,
    confidence     DOUBLE PRECISION DEFAULT 1.0,
    resolved_by    TEXT CHECK (resolved_by IN ('alias','vector_knn','llm')),
    PRIMARY KEY (work_order_id, attribute_id)
);
CREATE INDEX idx_woa_attr ON work_order_attributes(attribute_id);

-- Bookkeeping for what is in Qdrant, so the DB stays the source of truth.
CREATE TABLE vector_index_state (
    work_order_id  INT PRIMARY KEY REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
    collection     TEXT NOT NULL,
    vector_dim     INT NOT NULL,
    n_feature_vecs INT NOT NULL,
    indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE VIEW v_work_order_full AS
SELECT w.work_order_id, w.title, w.company, w.city, w.state, w.source, w.source_type,
       w.pay_type, w.pay_rate, w.duration_hours, w.status, w.posted_at,
       COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
           'type', a.attribute_type, 'name', a.canonical_name, 'id', a.attribute_id))
           FILTER (WHERE a.attribute_id IS NOT NULL), '[]'::jsonb) AS attributes
FROM work_orders w
LEFT JOIN work_order_attributes wa ON wa.work_order_id = w.work_order_id
LEFT JOIN core_job_attributes  a  ON a.attribute_id   = wa.attribute_id
GROUP BY w.work_order_id;
