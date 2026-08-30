import { randomUUID } from 'crypto';

export interface Actor { id: number; role: string }

export interface Envelope<T = any> {
  id: string;
  type: string;
  version: number;
  occurred_at: string;
  correlation_id: string;
  causation_id: string | null;
  actor: Actor | null;
  payload: T;
}

export function newEnvelope<T>(type: string, payload: T, opts: {
  correlationId?: string; causationId?: string; actor?: Actor; version?: number;
} = {}): Envelope<T> {
  return {
    id: randomUUID(),
    type,
    version: opts.version ?? 1,
    occurred_at: new Date().toISOString(),
    correlation_id: opts.correlationId ?? randomUUID(),
    causation_id: opts.causationId ?? null,
    actor: opts.actor ?? null,
    payload,
  };
}

/** Derive a follow-on event that keeps the saga linked. */
export function caused<T>(parent: Envelope, type: string, payload: T): Envelope<T> {
  return newEnvelope(type, payload, {
    correlationId: parent.correlation_id,
    causationId: parent.id,
    actor: parent.actor ?? undefined,
  });
}
