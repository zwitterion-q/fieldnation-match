import { Logger } from '@nestjs/common';
import { Gauge, Counter } from 'prom-client';
import { registry } from '../auth/metrics';

/**
 * A breaker that nobody can see is a breaker nobody trusts. These three series
 * are what turn "it protects us" into something you can point at on a graph
 * while it is happening.
 */
const breakerState = new Gauge({
  name: 'fn_breaker_state',
  help: 'Circuit breaker state — 0 closed, 1 half_open, 2 open',
  labelNames: ['breaker'],
  registers: [registry],
});

const breakerCalls = new Counter({
  name: 'fn_breaker_calls_total',
  help: 'Calls through the breaker, by outcome',
  labelNames: ['breaker', 'outcome'],   // success | failure | short_circuited
  registers: [registry],
});

const breakerTransitions = new Counter({
  name: 'fn_breaker_transitions_total',
  help: 'Breaker state transitions',
  labelNames: ['breaker', 'to'],
  registers: [registry],
});

const STATE_VALUE: Record<BreakerState, number> = { closed: 0, half_open: 1, open: 2 };

export type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * Circuit breaker.
 *
 * Retries assume a failure is transient. When a dependency is genuinely down,
 * retrying makes things worse twice over: the caller burns threads waiting on
 * timeouts, and the struggling dependency gets hammered while it tries to
 * recover. A breaker converts slow failure into fast failure.
 *
 *   closed     normal. Count failures.
 *   open       fail immediately without calling. No load on the dependency.
 *   half_open  after a cooldown, let ONE request through as a probe.
 *
 * The half-open state is the part people leave out, and it is the whole point:
 * without it you either stay open forever or slam the dependency with full
 * traffic the instant the timer expires.
 */
export class CircuitBreaker {
  private readonly log = new Logger('CircuitBreaker');
  private state: BreakerState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private probing = false;

  readonly stats = { calls: 0, failures: 0, short_circuited: 0, state_changes: [] as any[] };

  constructor(
    private name: string,
    private threshold = 5,        // consecutive failures before opening
    private cooldownMs = 10_000,  // how long to stay open before probing
    private probeSuccesses = 2,   // successes needed to close again
  ) {
    breakerState.set({ breaker: this.name }, STATE_VALUE.closed);
  }

  getState() {
    // Lazily transition out of open so no background timer is needed.
    if (this.state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) {
      this.transition('half_open');
    }
    // Re-publish every read. The lazy transition means the gauge would
    // otherwise go stale between calls, and a stale gauge on a dashboard is
    // worse than no gauge.
    breakerState.set({ breaker: this.name }, STATE_VALUE[this.state]);
    return this.state;
  }

  snapshot() {
    return {
      name: this.name, state: this.getState(), consecutive_failures: this.failures,
      threshold: this.threshold, cooldown_ms: this.cooldownMs, ...this.stats,
      state_changes: this.stats.state_changes.slice(-5),
    };
  }

  private transition(to: BreakerState) {
    if (this.state === to) return;
    this.log.warn(`breaker "${this.name}": ${this.state} → ${to}`);
    this.stats.state_changes.push({ from: this.state, to, at: new Date().toISOString() });
    this.state = to;
    breakerState.set({ breaker: this.name }, STATE_VALUE[to]);
    breakerTransitions.inc({ breaker: this.name, to });
    if (to === 'open') { this.openedAt = Date.now(); this.successes = 0; }
    if (to === 'closed') { this.failures = 0; this.successes = 0; }
    if (to === 'half_open') { this.successes = 0; this.probing = false; }
  }

  /** Run through the breaker. `fallback` is what a degraded response looks like. */
  async run<T>(fn: () => Promise<T>, fallback?: () => T): Promise<T> {
    const state = this.getState();
    this.stats.calls++;

    if (state === 'open') {
      this.stats.short_circuited++;
      breakerCalls.inc({ breaker: this.name, outcome: 'short_circuited' });
      if (fallback) return fallback();
      throw new Error(`circuit "${this.name}" is open`);
    }

    // In half-open, admit exactly one probe. Everything else short-circuits, so
    // a recovering dependency is not hit by the full backlog at once.
    if (state === 'half_open') {
      if (this.probing) {
        this.stats.short_circuited++;
        breakerCalls.inc({ breaker: this.name, outcome: 'short_circuited' });
        if (fallback) return fallback();
        throw new Error(`circuit "${this.name}" is half-open and already probing`);
      }
      this.probing = true;
    }

    try {
      const out = await fn();
      breakerCalls.inc({ breaker: this.name, outcome: 'success' });
      this.onSuccess();
      return out;
    } catch (e) {
      breakerCalls.inc({ breaker: this.name, outcome: 'failure' });
      this.onFailure();
      if (fallback) return fallback();
      throw e;
    } finally {
      if (this.state === 'half_open') this.probing = false;
    }
  }

  private onSuccess() {
    if (this.state === 'half_open') {
      if (++this.successes >= this.probeSuccesses) this.transition('closed');
    } else {
      this.failures = 0;
    }
  }

  private onFailure() {
    this.stats.failures++;
    // A failed probe means the dependency is still sick: straight back to open,
    // and the cooldown restarts.
    if (this.state === 'half_open') { this.transition('open'); return; }
    if (++this.failures >= this.threshold) this.transition('open');
  }

  /** Manual control, for demonstrating the states without breaking a dependency. */
  forceOpen() { this.failures = this.threshold; this.transition('open'); }
  forceClose() { this.transition('closed'); }
}
