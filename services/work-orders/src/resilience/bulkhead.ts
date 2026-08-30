import { Logger } from '@nestjs/common';

/**
 * Bulkhead isolation.
 *
 * Named after ship compartments: a hull breach floods one compartment, not the
 * vessel. Here it caps how many calls to one dependency may be in flight at
 * once, so a slow dependency cannot consume every worker and take down handlers
 * that have nothing to do with it.
 *
 * A circuit breaker protects you from a dependency that is DOWN. A bulkhead
 * protects you from one that is SLOW -- which is the more dangerous failure,
 * because nothing errors and everything queues.
 */
export class Bulkhead {
  private readonly log = new Logger('Bulkhead');
  private inFlight = 0;
  readonly stats = { accepted: 0, rejected: 0, max_observed: 0 };

  constructor(private name: string, private limit = 10) {}

  snapshot() {
    return { name: this.name, limit: this.limit, in_flight: this.inFlight, ...this.stats };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limit) {
      this.stats.rejected++;
      // Shed load rather than queue it. An unbounded queue in front of a slow
      // dependency just moves the failure somewhere harder to see.
      throw new Error(`bulkhead "${this.name}" full (${this.inFlight}/${this.limit})`);
    }
    this.inFlight++;
    this.stats.accepted++;
    this.stats.max_observed = Math.max(this.stats.max_observed, this.inFlight);
    try {
      return await fn();
    } finally {
      this.inFlight--;
    }
  }
}
