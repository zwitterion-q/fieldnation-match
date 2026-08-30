-- ===========================================================================
-- Technician side. Deliberately a separate database with its own schema:
-- the two services own their data. The taxonomy is replicated here from the
-- same seed file rather than shared by foreign key, which is what you would
-- actually do across a service boundary.
-- ===========================================================================

CREATE TABLE core_job_attributes (
    attribute_id    INT PRIMARY KEY,          -- ids mirror the work-order side
    attribute_type  TEXT NOT NULL,
    slug            TEXT NOT NULL,
    canonical_name  TEXT NOT NULL,
    description     TEXT,
    UNIQUE (attribute_type, slug)
);
CREATE INDEX idx_t_cja_type ON core_job_attributes(attribute_type);

CREATE TABLE technicians (
    technician_id   SERIAL PRIMARY KEY,
    external_id     TEXT UNIQUE NOT NULL,
    full_name       TEXT NOT NULL,
    headline        TEXT,
    bio             TEXT,
    city            TEXT,
    state           TEXT,
    country         TEXT DEFAULT 'US',
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    travel_radius_mi INT DEFAULT 50,
    hourly_rate     NUMERIC(10,2),
    currency        TEXT DEFAULT 'USD',
    rating          NUMERIC(3,2) CHECK (rating BETWEEN 0 AND 5),
    jobs_completed  INT DEFAULT 0,
    years_experience NUMERIC(4,1),
    available_from  DATE,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tech_geo ON technicians(state, city);

CREATE TABLE technician_features (
    feature_id     SERIAL PRIMARY KEY,
    technician_id  INT NOT NULL REFERENCES technicians(technician_id) ON DELETE CASCADE,
    feature_type   TEXT NOT NULL,
    feature_text   TEXT NOT NULL,
    weight         DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    UNIQUE (technician_id, feature_type, feature_text)
);
CREATE INDEX idx_tf_tech ON technician_features(technician_id);

CREATE TABLE technician_attributes (
    technician_id  INT NOT NULL REFERENCES technicians(technician_id) ON DELETE CASCADE,
    attribute_id   INT NOT NULL REFERENCES core_job_attributes(attribute_id),
    years          NUMERIC(4,1),
    proficiency    TEXT CHECK (proficiency IN ('familiar','proficient','expert')),
    PRIMARY KEY (technician_id, attribute_id)
);
CREATE INDEX idx_ta_attr ON technician_attributes(attribute_id);

CREATE TABLE vector_index_state (
    technician_id  INT PRIMARY KEY REFERENCES technicians(technician_id) ON DELETE CASCADE,
    collection     TEXT NOT NULL,
    vector_dim     INT NOT NULL,
    n_feature_vecs INT NOT NULL,
    indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE VIEW v_technician_full AS
SELECT t.technician_id, t.external_id, t.full_name, t.headline, t.city, t.state,
       t.hourly_rate, t.rating, t.jobs_completed, t.years_experience, t.travel_radius_mi,
       COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
           'type', a.attribute_type, 'name', a.canonical_name, 'id', a.attribute_id))
           FILTER (WHERE a.attribute_id IS NOT NULL), '[]'::jsonb) AS attributes
FROM technicians t
LEFT JOIN technician_attributes ta ON ta.technician_id = t.technician_id
LEFT JOIN core_job_attributes   a  ON a.attribute_id   = ta.attribute_id
GROUP BY t.technician_id;
