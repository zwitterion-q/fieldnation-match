"""Names of the declared topology. Nothing here creates anything -- the broker
is provisioned from infra/rabbitmq/definitions.json. Services only reference."""

EX_EVENTS  = "fieldnation.events"
EX_RETRY   = "fieldnation.retry"
EX_REQUEUE = "fieldnation.requeue"
EX_PARKING = "fieldnation.parking"

# Tier -> delay. Must match the x-message-ttl on q.<svc>.retry.<tier>.
TIERS = ["r1", "r2", "r3"]
TIER_DELAY_MS = {"r1": 5_000, "r2": 30_000, "r3": 300_000}
MAX_ATTEMPTS = len(TIERS)          # after r3 fails, park it


def main_queue(service: str, event: str) -> str:
    return f"q.{service}.{event}"


def retry_routing_key(service: str, tier: str, event: str) -> str:
    """Lands in q.<svc>.retry.<tier> (bound on '<svc>.<tier>.#'), then dead-letters
    to fieldnation.requeue preserving THIS key, where the main queue is bound on
    '<svc>.*.<event>'. That wildcard is what lets one retry queue per tier serve
    every event type for the service."""
    return f"{service}.{tier}.{event}"


def parking_routing_key(service: str, event: str) -> str:
    return f"{service}.{event}"
