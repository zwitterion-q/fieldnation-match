import { Controller, Get, Post, Body, Param, ParseIntPipe, NotFoundException, Res } from '@nestjs/common';
import { Response } from 'express';
import { StranglerService, Mode, servedBy } from './strangler.service';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import { Bulkhead } from '../resilience/bulkhead';

/**
 * The legacy service is the only synchronous cross-service dependency here, and
 * during a migration it is the riskiest thing in the system: if it degrades,
 * every read behind the facade degrades with it.
 *
 * Breaker: stop calling a dependency that is down, and fall back to the NEW
 * implementation. During a strangler migration that fallback is unusually good --
 * the replacement is already built and proven equivalent in shadow, so a legacy
 * outage degrades into an accelerated migration rather than an incident.
 */
const legacyBreaker = new CircuitBreaker('legacy-api', 3, 10_000, 2);
const legacyBulkhead = new Bulkhead('legacy-api', 20);
import { Public, RequirePermissions } from '../auth/jwt.strategy';
import { P } from '../auth/permissions';

const LEGACY = process.env.LEGACY_API_URL || 'http://api:8000';

/**
 * The facade. Every read for a work order goes through here, and this is the
 * only place that knows a migration is in progress -- callers never do.
 */
@Controller()
export class StranglerController {
  constructor(private strangler: StranglerService) {}

  @Public() @Get('strangler/status')
  status() {
    return { ...this.strangler.getConfig(),
             resilience: { breaker: legacyBreaker.snapshot(), bulkhead: legacyBulkhead.snapshot() } };
  }

  /** Trip or reset the breaker by hand, to demonstrate the states without
   *  having to actually break the dependency. */
  @Post('strangler/breaker/:action') @RequirePermissions(P.PLATFORM_ADMIN)
  breaker(@Param('action') action: string) {
    if (action === 'open') legacyBreaker.forceOpen();
    else if (action === 'close') legacyBreaker.forceClose();
    return legacyBreaker.snapshot();
  }

  /** Move the migration forward or roll it back at runtime, no redeploy. */
  @Post('strangler/config') @RequirePermissions(P.PLATFORM_ADMIN)
  configure(@Body() body: { mode?: Mode; canary_percent?: number }) {
    return this.strangler.setConfig(body.mode, body.canary_percent);
  }

  @Public() @Get('strangler/work-orders/:id')
  async read(@Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response) {
    const useNew = this.strangler.routeToNew(id);

    // ---- canary / fully migrated: serve from this service -----------------
    if (useNew) {
      const next = await this.strangler.readWorkOrder(id);
      if (!next) throw new NotFoundException();
      this.strangler.stats.new_served++;
      servedBy.inc({ implementation: 'work-orders' });
      res.setHeader('x-served-by', 'work-orders');
      return next;
    }

    // ---- legacy path, behind a breaker and a bulkhead ---------------------
    let fellBack = false;
    const legacy = await legacyBreaker.run(
      () => legacyBulkhead.run(async () => {
        // Always bound the wait. An unbounded call to a sick dependency is how
        // one slow service exhausts every worker in the caller.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        try {
          const r = await fetch(`${LEGACY}/work-orders/${id}`, { signal: ctrl.signal });

          // A 4xx is NOT a dependency failure. The legacy service is healthy and
          // answering correctly -- the client asked for something that does not
          // exist. Counting client errors against the breaker means one bad
          // request pattern can trip it for every other user, which is a far
          // worse outage than the one the breaker exists to prevent.
          //
          // Only 5xx, timeouts and connection errors indicate a sick dependency.
          if (r.status >= 400 && r.status < 500) return { __notFound: true, status: r.status };
          if (!r.ok) throw new Error(`legacy returned ${r.status}`);
          return await r.json();
        } finally { clearTimeout(timer); }
      }),
      // Fallback: serve from the NEW implementation. During a strangler
      // migration this fallback is unusually strong -- the replacement is
      // already built and proven equivalent in shadow, so a legacy outage
      // degrades into an accelerated migration rather than an incident.
      () => { fellBack = true; return null; },
    );

    // Legacy answered, and its answer was "no such thing". Honour it.
    if (legacy && (legacy as any).__notFound) {
      res.setHeader('x-served-by', 'legacy-api');
      throw new NotFoundException();
    }

    if (fellBack) {
      const next = await this.strangler.readWorkOrder(id);
      if (!next) throw new NotFoundException();
      this.strangler.stats.new_served++;
      servedBy.inc({ implementation: 'work-orders-fallback' });
      res.setHeader('x-served-by', 'work-orders');
      res.setHeader('x-fallback', 'legacy-unavailable');
      return next;
    }

    this.strangler.stats.legacy_served++;
    servedBy.inc({ implementation: 'legacy-api' });
    res.setHeader('x-served-by', 'legacy-api');

    // ---- shadow: run the new path too, compare, discard --------------------
    if (this.strangler.isShadow()) {
      // Not awaited on the request path. Shadow comparison must never add
      // latency to a user request or fail one -- if the new code throws, the
      // user is unaffected and the divergence is what we wanted to learn.
      queueMicrotask(async () => {
        try {
          const next = await this.strangler.readWorkOrder(id);
          this.strangler.compare(id, legacy, next);
        } catch (e: any) {
          this.strangler.stats.shadow_diverged++;
          this.strangler.stats.divergences.push(
            { work_order_id: id, error: e.message, at: new Date().toISOString() });
        }
      });
      res.setHeader('x-shadow', 'on');
    }

    if (!legacy) throw new NotFoundException();
    return legacy;
  }
}
