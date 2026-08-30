import { newEnvelope, caused } from '@fn/tsevents';
import { deathCount } from '@fn/tsevents';

describe('event envelope', () => {
  it('generates a unique id and correlation id per event', () => {
    const a = newEnvelope('workorder.dispatched', { work_order_id: 1 });
    const b = newEnvelope('workorder.dispatched', { work_order_id: 1 });
    expect(a.id).not.toBe(b.id);
    expect(a.correlation_id).not.toBe(b.correlation_id);
  });

  it('links a caused event into the same saga', () => {
    const parent = newEnvelope('workorder.dispatched', { work_order_id: 7 },
      { actor: { id: 3, role: 'hirer' } });
    const child = caused(parent, 'payment.hold_placed', { work_order_id: 7 });

    // Same correlation id groups the saga; causation id names the direct parent.
    expect(child.correlation_id).toBe(parent.correlation_id);
    expect(child.causation_id).toBe(parent.id);
    expect(child.id).not.toBe(parent.id);
    expect(child.actor).toEqual(parent.actor);
  });

  it('keeps a whole chain under one correlation id', () => {
    const a = newEnvelope('workorder.dispatched', {});
    const b = caused(a, 'payment.hold_placed', {});
    const c = caused(b, 'workorder.accepted', {});
    expect(new Set([a, b, c].map(e => e.correlation_id)).size).toBe(1);
    expect(c.causation_id).toBe(b.id);
  });
});

describe('x-death handling', () => {
  it('returns zero when the broker has never dead-lettered the message', () => {
    expect(deathCount({})).toBe(0);
    expect(deathCount(undefined)).toBe(0);
  });

  it('sums counts across multiple death records', () => {
    expect(deathCount({ 'x-death': [
      { count: 2, reason: 'expired', queue: 'q.a', exchange: 'x', 'routing-keys': [] },
      { count: 3, reason: 'rejected', queue: 'q.b', exchange: 'x', 'routing-keys': [] },
    ]})).toBe(5);
  });

  it('catches deaths our own counter never sees, such as TTL expiry', () => {
    // A message dead-lettered by queue TTL carries no application header.
    const headers = { 'x-death': [{ count: 4, reason: 'expired', queue: 'q.x',
                                    exchange: 'e', 'routing-keys': [] }] };
    const ours = Number(headers['x-fn-attempt'] ?? 0);
    expect(ours).toBe(0);
    expect(Math.max(ours, deathCount(headers))).toBe(4);
  });
});
