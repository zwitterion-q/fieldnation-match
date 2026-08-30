# Field Nation — Work Order / Technician Matching Engine

A working two-sided matching system for a field-service marketplace: work orders
on one side, technicians on the other, matched in a shared embedding space with
per-feature explainability.

It is the CareerOne matching architecture retargeted at Field Nation's domain.
Jobs become work orders, candidates become technicians, and the same pipeline
runs end to end: **ingest → clean → de-duplicate → normalise into typed features
→ resolve those features to canonical taxonomy ids → embed each feature → combine
into one weighted centroid → index in Qdrant → match both directions.**

## Running it

Two deployment targets, same application code:

```bash
make up          # local — docker compose, ~3 min, free
make aws-up      # aws   — EKS + RDS + Amazon MQ, ~25 min, ~$0.27/hour
make aws-down    # tears the AWS one down and proves nothing is left billing
```

`make aws-validate` checks all the Terraform and every Kubernetes manifest
offline — no AWS account needed. See **[DEPLOYMENT.md](DEPLOYMENT.md)** for
what differs between the two and why.

The manual local path:

```bash
docker compose up -d db-workorders db-technicians qdrant   # infra
docker compose run --rm ingest python -m pipeline --all     # build the data
docker compose up -d api web-buyer web-tech                 # surfaces
```

| Surface | URL | What it is |
|---|---|---|
| Buyer console | http://localhost:55173 | Work orders, normalised attributes, ranked technicians |
| Technician app | http://localhost:55174 | Mobile-shaped: work orders ranked for one technician |
| API docs | http://localhost:58000/docs | OpenAPI |
| Qdrant dashboard | http://localhost:56333/dashboard | Collections and vectors |

## Architecture

```
  arbeitnow ┐
  remotive  ├─ live public APIs (real, messy HTML)
  jobicy    ┤
  adzuna    ┘  (key-gated)
  synthetic ─── Field Nation-shaped generator, incl. deliberate near-duplicates
        │
        ▼
  strip_html ──► content_hash ──► [layer 1: exact dedup]
        │
        ▼
  extraction (LLM if OPENAI_API_KEY, else deterministic rules — same contract)
        │  title · body · skills · experiences · experience_level
        │  industry · experience_types · certifications
        ▼
  TaxonomyResolver ── alias exact match ─┐
                   └─ taxonomy kNN ──────┴──► core_job_attributes.attribute_id
        │
        ▼
  per-feature embeddings ──► weighted centroid ──► [layer 2: vector dedup]
        │
        ▼
  Qdrant: work_orders · technicians · tax_skill · tax_experience ·
          tax_experience_level · tax_industry · tax_experience_type ·
          tax_certification
```

### Two databases, one vocabulary

`workorders` and `technicians` are separate Postgres instances — each service
owns its schema, as they would in production. The taxonomy is **replicated** into
both from `taxonomy/taxonomy.json` rather than shared by foreign key, because you
cannot foreign-key across a service boundary. Attribute ids are identical on both
sides, which is what makes the two centroids comparable.

### The centroid

Every normalised feature is embedded independently, then combined by weight into
one vector per entity (`ingest/embedding.py`). Weights live in `ingest/config.py`
and are renormalised over whichever features an entity actually has, so a work
order with no stated industry is not pushed into a different region of the space.

Because each feature *also* stays indexed in its taxonomy collection, a match can
be decomposed after the fact — which is what `/matches` returns and what both UIs
render. A single cosine score is not something you can show a buyer.

### Two dedup layers

1. **Content hash** — byte-identical reposts, free.
2. **Vector kNN** — the same work order reworded across channels, which hashing
   cannot see. The synthetic generator emits a controlled slice of reworded
   near-duplicates specifically so this layer is visible rather than theoretical.

### Extraction without a hard dependency

`RuleExtractor` and `LLMExtractor` implement one interface and return the same
`ExtractedFeatures`. With `OPENAI_API_KEY` set, extraction is a schema-constrained
LLM pass; without it, deterministic alias and keyword matching. The LLM path falls
back to rules on any error, so a rate limit degrades quality instead of breaking
the pipeline. The demo runs fully offline.

## Data provenance

Every work order carries `source_type`:

* `live_api` — genuinely fetched from public job APIs. Real, inconsistent, HTML-laden.
* `synthetic` — generated field-service work orders, because open job APIs are
  remote-work boards and carry almost no on-site technician work.

`/stats` and the buyer console both break this down. Set `ADZUNA_APP_ID` /
`ADZUNA_APP_KEY` in `.env` to pull real on-site trade work and shift the mix.

## Interesting endpoints

```
GET /stats                        pipeline provenance, dedup counts, resolution mix
GET /work-orders/{id}             normalised attributes + how each was resolved
GET /work-orders/{id}/matches     buyer side: who should do this job
GET /technicians/{id}/matches     technician side: which jobs suit me
GET /resolve?q=...&attribute_type=skill
                                  live phrase → taxonomy id resolution
```

`/resolve` is the normalisation step exposed on its own — type
`ran cat6 above the ceiling grid` and watch it land on **Structured Cabling**
without an alias for that phrase existing.

## Layout

```
db/{workorders,technicians}/   schemas
taxonomy/taxonomy.json         70 attributes, 256 aliases, 6 types
ingest/                        sources, cleaning, extraction, resolver, dedupe, pipeline
api/                           FastAPI + matching/explanation
web-buyer/  web-tech/          React (Vite), nginx, proxied to the API
```
