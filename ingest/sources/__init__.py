"""Source adapters. Every adapter returns the same RawJob shape, which is what
lets one normalisation path serve APIs, feeds and generated work alike."""
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class RawJob:
    external_id: str
    source: str
    source_type: str          # live_api | synthetic
    title: str
    body_raw: str
    company: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    country: str = "US"
    source_url: Optional[str] = None
    posted_at: Optional[str] = None
    pay_type: Optional[str] = None
    pay_rate: Optional[float] = None
    duration_hours: Optional[float] = None
    tags: list = field(default_factory=list)
