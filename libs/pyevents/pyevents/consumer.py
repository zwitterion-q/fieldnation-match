"""The consumer contract.

Every consumer in every service must behave identically here, or messages either
loop forever or vanish. Implemented once, per language, on purpose.

On handler failure the consumer does NOT nack. It reads the attempt count it is
carrying, republishes itself to the next retry tier, and acks the original.
Application-level retry routing rather than broker nack, because nack-driven
dead-lettering cannot choose *which* tier to land in.
"""
from __future__ import annotations
import json, logging, time
from typing import Callable

import pika
from pika.exchange_type import ExchangeType

from .envelope import Envelope
from .topology import (EX_EVENTS, EX_RETRY, EX_PARKING, TIERS, MAX_ATTEMPTS,
                       main_queue, retry_routing_key, parking_routing_key)

log = logging.getLogger("pyevents")

ATTEMPT_HEADER = "x-fn-attempt"


class Consumer:
    def __init__(self, url: str, service: str, prefetch: int = 20):
        self.url, self.service, self.prefetch = url, service, prefetch
        self._handlers: dict[str, Callable[[Envelope], None]] = {}
        self._seen: set[str] = set()          # replaced by a DB table per service

    def on(self, event: str):
        def deco(fn):
            self._handlers[event] = fn
            return fn
        return deco

    # -------------------------------------------------------------- internals
    def _attempt_of(self, props) -> int:
        h = props.headers or {}
        return int(h.get(ATTEMPT_HEADER, 0))

    def _republish(self, ch, exchange: str, routing_key: str, body: bytes, attempt: int):
        ch.basic_publish(
            exchange=exchange, routing_key=routing_key, body=body,
            properties=pika.BasicProperties(
                delivery_mode=2,                       # persistent
                content_type="application/json",
                headers={ATTEMPT_HEADER: attempt}),
        )

    def _handle(self, ch, method, props, body):
        try:
            env = Envelope.from_bytes(body)
        except Exception:
            log.error("unparseable message, parking immediately")
            self._republish(ch, EX_PARKING, f"{self.service}.unparseable", body, 99)
            ch.basic_ack(method.delivery_tag)
            return

        # Idempotency. At-least-once delivery means duplicates are normal, not
        # exceptional -- a replayed payment hold would double-charge a hirer.
        if env.id in self._seen:
            log.info("duplicate %s %s — skipping", env.type, env.id)
            ch.basic_ack(method.delivery_tag)
            return

        handler = self._handlers.get(env.type)
        if handler is None:
            log.warning("no handler for %s — acking", env.type)
            ch.basic_ack(method.delivery_tag)
            return

        attempt = self._attempt_of(props)
        try:
            handler(env)
            self._seen.add(env.id)
            ch.basic_ack(method.delivery_tag)
        except Exception as e:
            if attempt >= MAX_ATTEMPTS:
                log.error("%s %s failed %d times — parking: %s",
                          env.type, env.id, attempt, e)
                self._republish(ch, EX_PARKING,
                                parking_routing_key(self.service, env.type), body, attempt)
            else:
                tier = TIERS[attempt]
                log.warning("%s %s failed (attempt %d) — retrying via %s: %s",
                            env.type, env.id, attempt + 1, tier, e)
                self._republish(ch, EX_RETRY,
                                retry_routing_key(self.service, tier, env.type),
                                body, attempt + 1)
            ch.basic_ack(method.delivery_tag)   # original is now represented elsewhere

    # ------------------------------------------------------------------- run
    def run(self):
        params = pika.URLParameters(self.url)
        params.heartbeat = 30
        conn = pika.BlockingConnection(params)
        ch = conn.channel()
        ch.confirm_delivery()                    # publisher confirms
        ch.basic_qos(prefetch_count=self.prefetch)

        for event in self._handlers:
            qname = main_queue(self.service, event)
            ch.basic_consume(queue=qname, on_message_callback=self._handle)
            log.info("consuming %s", qname)
        log.info("%s ready (prefetch=%d)", self.service, self.prefetch)
        ch.start_consuming()


class Publisher:
    """Publisher confirms on. A publish that is not confirmed raises, so the
    outbox relay will retry it rather than marking it sent."""

    def __init__(self, url: str):
        self.url = url
        self._conn = None
        self._ch = None

    def _channel(self):
        if self._ch is None or self._ch.is_closed:
            params = pika.URLParameters(self.url)
            params.heartbeat = 30
            self._conn = pika.BlockingConnection(params)
            self._ch = self._conn.channel()
            self._ch.confirm_delivery()
        return self._ch

    def publish(self, env: Envelope) -> None:
        self._channel().basic_publish(
            exchange=EX_EVENTS, routing_key=env.type, body=env.to_bytes(),
            properties=pika.BasicProperties(
                delivery_mode=2, content_type="application/json",
                message_id=env.id, correlation_id=env.correlation_id,
                headers={ATTEMPT_HEADER: 0}),
        )
