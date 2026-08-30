"""Three public job APIs, used without keys. They return genuinely messy data --
HTML-laden descriptions, inconsistent location strings, different field names --
which is the point: the cleaning and normalisation layers have real work to do.

Adzuna and USAJobs adapters activate automatically when keys are present.
"""
from __future__ import annotations
import os, requests
from . import RawJob

UA = {"User-Agent": "fieldnation-match/0.1 (interview portfolio project)"}
TIMEOUT = 25

# Terms that bias the pull toward on-site technical work.
FIELD_TERMS = ("technician", "field service", "install", "cabling", "network",
               "hardware", "repair", "maintenance", "electrical", "hvac",
               "engineer", "support", "onsite", "on-site", "deployment")


def _relevant(text: str) -> bool:
    t = text.lower()
    return any(term in t for term in FIELD_TERMS)


def fetch_arbeitnow(limit: int = 120) -> list[RawJob]:
    out = []
    try:
        data = requests.get("https://www.arbeitnow.com/api/job-board-api",
                            headers=UA, timeout=TIMEOUT).json().get("data", [])
    except Exception as e:
        print(f"  [arbeitnow] unavailable: {e}")
        return out
    for j in data:
        blob = f"{j.get('title','')} {j.get('description','')[:600]}"
        if not _relevant(blob):
            continue
        loc = (j.get("location") or "").split(",")
        out.append(RawJob(
            external_id=str(j.get("slug") or j.get("id")),
            source="arbeitnow", source_type="live_api",
            title=(j.get("title") or "").strip(),
            body_raw=j.get("description") or "",
            company=j.get("company_name"),
            city=loc[0].strip() if loc else None,
            state=loc[1].strip() if len(loc) > 1 else None,
            country="DE",
            source_url=j.get("url"),
            tags=j.get("tags") or [],
        ))
        if len(out) >= limit:
            break
    return out


def fetch_remotive(limit: int = 60) -> list[RawJob]:
    out = []
    try:
        data = requests.get("https://remotive.com/api/remote-jobs?limit=200",
                            headers=UA, timeout=TIMEOUT).json().get("jobs", [])
    except Exception as e:
        print(f"  [remotive] unavailable: {e}")
        return out
    for j in data:
        if not _relevant(f"{j.get('title','')} {j.get('description','')[:600]}"):
            continue
        out.append(RawJob(
            external_id=str(j.get("id")),
            source="remotive", source_type="live_api",
            title=(j.get("title") or "").strip(),
            body_raw=j.get("description") or "",
            company=j.get("company_name"),
            city=j.get("candidate_required_location"),
            source_url=j.get("url"),
            posted_at=j.get("publication_date"),
            tags=j.get("tags") or [],
        ))
        if len(out) >= limit:
            break
    return out


def fetch_jobicy(limit: int = 60) -> list[RawJob]:
    out = []
    try:
        data = requests.get("https://jobicy.com/api/v2/remote-jobs?count=100",
                            headers=UA, timeout=TIMEOUT).json().get("jobs", [])
    except Exception as e:
        print(f"  [jobicy] unavailable: {e}")
        return out
    for j in data:
        if not _relevant(f"{j.get('jobTitle','')} {str(j.get('jobExcerpt',''))[:400]}"):
            continue
        out.append(RawJob(
            external_id=str(j.get("id")),
            source="jobicy", source_type="live_api",
            title=(j.get("jobTitle") or "").strip(),
            body_raw=j.get("jobDescription") or j.get("jobExcerpt") or "",
            company=j.get("companyName"),
            city=j.get("jobGeo"),
            source_url=j.get("url"),
            posted_at=j.get("pubDate"),
            tags=j.get("jobIndustry") or [],
        ))
        if len(out) >= limit:
            break
    return out


def fetch_adzuna(limit: int = 100) -> list[RawJob]:
    """Real on-site trade work -- activates when ADZUNA_APP_ID/KEY are set."""
    app_id, app_key = os.getenv("ADZUNA_APP_ID"), os.getenv("ADZUNA_APP_KEY")
    if not (app_id and app_key):
        return []
    out = []
    for what in ("field service technician", "low voltage technician",
                 "network cabling installer", "pos installation technician"):
        try:
            r = requests.get(
                "https://api.adzuna.com/v1/api/jobs/us/search/1",
                params={"app_id": app_id, "app_key": app_key,
                        "results_per_page": 40, "what": what, "content-type": "application/json"},
                headers=UA, timeout=TIMEOUT).json()
        except Exception as e:
            print(f"  [adzuna] {what}: {e}")
            continue
        for j in r.get("results", []):
            loc = j.get("location", {}).get("area", [])
            out.append(RawJob(
                external_id=str(j.get("id")), source="adzuna", source_type="live_api",
                title=j.get("title", ""), body_raw=j.get("description", ""),
                company=(j.get("company") or {}).get("display_name"),
                city=loc[-1] if loc else None, state=loc[1] if len(loc) > 1 else None,
                source_url=j.get("redirect_url"), posted_at=j.get("created"),
                pay_type="hourly" if j.get("salary_is_predicted") == "0" else None,
            ))
            if len(out) >= limit:
                return out
    return out


ALL_LIVE = [fetch_arbeitnow, fetch_remotive, fetch_jobicy, fetch_adzuna]
