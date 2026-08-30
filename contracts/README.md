# Event contracts

Every message on the bus is a **versioned envelope**. Consumers match on
`type` + `version`, never on queue name, so a producer can add a new event
version without breaking existing consumers.

```json
{
  "id":            "uuid-v4",          // unique per message, used for idempotency
  "type":          "workorder.dispatched",
  "version":       1,
  "occurred_at":   "2026-08-29T11:04:22Z",
  "correlation_id":"uuid-v4",          // one business transaction, many events
  "causation_id":  "uuid-v4",          // the message that caused this one
  "actor":         {"id": 12, "role": "hirer"},
  "payload":       { ... }
}
```

`correlation_id` and `causation_id` together let you reconstruct an entire saga
from the logs — which event triggered which — without distributed tracing
infrastructure. That is the cheapest useful observability you can build into an
event system on day one.

## Routing keys

Exchange `fieldnation.events` (topic, durable).

| Routing key | Producer | Consumers |
|---|---|---|
| `workorder.dispatched` | work-orders | payments, notifications, matching |
| `workorder.accepted`   | work-orders | payments, notifications, matching |
| `workorder.rejected`   | work-orders | payments, notifications, matching |
| `workorder.completed`  | work-orders | payments, notifications |
| `workorder.cancelled`  | work-orders | payments, notifications |
| `payment.hold_placed`  | payments    | work-orders, notifications |
| `payment.hold_released`| payments    | work-orders, notifications |
| `payment.captured`     | payments    | notifications |
| `identity.user_created`| identity    | notifications |

## Delivery guarantees

At-least-once. Publishers use **publisher confirms**; producers write to a
**transactional outbox** in the same DB transaction as the state change, and a
relay publishes after commit. This removes the dual-write problem: the state
change and the intent to publish either both commit or neither does.

Because delivery is at-least-once, **every consumer is idempotent** — each
service keeps a `processed_messages` table keyed on the envelope `id` and
short-circuits on replay.

## Failure handling

Each consumer queue has a dead-letter exchange. Failures move through a retry
ladder with increasing TTL, then land in a parking lot for manual inspection:

```
q.<service>.<event>          --nack--> x.retry --TTL 5s --> q.<service>.retry.5s
   ^                                                              |
   |______________________ dead-letters back _____________________|
                     (3 attempts: 5s, 30s, 5m)
                                |
                                v  after final attempt
                        q.<service>.parking-lot
```

Retry delay is implemented with per-queue `x-message-ttl` plus
`x-dead-letter-exchange` rather than the delayed-message plugin, so the topology
stays portable across managed brokers that do not allow plugins.
