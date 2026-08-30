"""The message envelope shared by every service, in every language.

`correlation_id` groups every event belonging to one business transaction;
`causation_id` names the message that directly caused this one. Together they
let a whole saga be reconstructed from logs without distributed tracing.
"""
from __future__ import annotations
import json, uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class Envelope:
    type: str
    payload: dict
    version: int = 1
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    occurred_at: str = field(default_factory=_now)
    correlation_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    causation_id: str | None = None
    actor: dict | None = None

    def to_bytes(self) -> bytes:
        return json.dumps(asdict(self), separators=(",", ":")).encode()

    @staticmethod
    def from_bytes(raw: bytes) -> "Envelope":
        d = json.loads(raw.decode())
        return Envelope(**{k: d.get(k) for k in
                           ("type", "payload", "version", "id", "occurred_at",
                            "correlation_id", "causation_id", "actor")})

    def caused(self, type_: str, payload: dict) -> "Envelope":
        """Derive a follow-on event that keeps the saga linked."""
        return Envelope(type=type_, payload=payload,
                        correlation_id=self.correlation_id, causation_id=self.id,
                        actor=self.actor)
