import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Counter, Gauge } from 'prom-client';
import { registry } from '../auth/metrics';

/** A migration you cannot watch is a migration you cannot roll forward with
 *  confidence. These are the numbers that decide whether to advance a stage. */
export const servedBy = new Counter({
  name: 'strangler_requests_total', help: 'Requests by implementation',
  labelNames: ['implementation'], registers: [registry] });
const shadowCmp = new Counter({
  name: 'strangler_shadow_comparisons_total', help: 'Shadow comparisons by outcome',
  labelNames: ['outcome'], registers: [registry] });
const stageGauge = new Gauge({
  name: 'strangler_stage', help: 'Migration stage: 0 legacy, 1 shadow, 2 canary, 3 new',
  registers: [registry] });
const canaryGauge = new Gauge({
  name: 'strangler_canary_percent', help: 'Percent of traffic on the new path',
  registers: [registry] });

export type Mode = 'legacy' | 'shadow' | 'canary' | 'new';

/**
 * Strangler fig migration control.
 *
 * The legacy Python service still reads work orders straight from the database.
 * This service now owns the work-order domain, so the read path is being moved
 * across incrementally rather than in one cutover.
 *
 * Four stages, in order:
 *
 *   legacy   all traffic to the old service. The new path is dark.
 *   shadow   every request goes to BOTH. The legacy response is served; the new
 *            one is compared and discarded. Divergence is measured against real
 *            production traffic with zero user risk. This is the stage that
 *            actually de-risks a migration, and the one people skip.
 *   canary   a percentage is served by the new path. Roll forward or back on
 *            the divergence and error numbers from shadow.
 *   new      the old read path is dead and can be deleted.
 *
 * The point of the fig metaphor: the new system grows around the old one until
 * the old one can be removed without anybody noticing it has gone.
 */
@Injectable()
export class StranglerService {
  private readonly log = new Logger('Strangler');

  private mode: Mode = (process.env.STRANGLER_MODE as Mode) || 'shadow';
  private canaryPct = Number(process.env.STRANGLER_CANARY_PCT ?? 10);

  readonly stats = {
    legacy_served: 0, new_served: 0,
    shadow_compared: 0, shadow_matched: 0, shadow_diverged: 0,
    divergences: [] as any[],
  };

  constructor(@InjectDataSource() private ds: DataSource) {
    // Publish the starting stage immediately. A gauge that only updates when
    // someone changes it reports 0 for a system that is actually in shadow --
    // which is exactly the class of lie load testing caught in the dashboard.
    this.publishGauges();
  }

  private publishGauges() {
    stageGauge.set({ legacy: 0, shadow: 1, canary: 2, new: 3 }[this.mode]);
    canaryGauge.set(this.mode === 'new' ? 100 : this.mode === 'canary' ? this.canaryPct : 0);
  }

  getConfig() {
    return {
      mode: this.mode, canary_percent: this.canaryPct,
      stats: { ...this.stats, divergences: this.stats.divergences.slice(-10) },
      divergence_rate: this.stats.shadow_compared
        ? +(this.stats.shadow_diverged / this.stats.shadow_compared).toFixed(4) : null,
    };
  }

  setConfig(mode?: Mode, pct?: number) {
    if (mode) this.mode = mode;
    if (pct !== undefined) this.canaryPct = Math.max(0, Math.min(100, pct));
    this.publishGauges();
    this.log.warn(`strangler → mode=${this.mode} canary=${this.canaryPct}%`);
    return this.getConfig();
  }

  /** Deterministic on the entity id, so one work order never flips between
   *  implementations on refresh -- a user seeing two different answers is worse
   *  than a user seeing the old one. */
  routeToNew(key: number): boolean {
    if (this.mode === 'new') return true;
    if (this.mode === 'legacy' || this.mode === 'shadow') return false;
    return (key * 2654435761) % 100 < this.canaryPct;   // Knuth multiplicative hash
  }

  isShadow() { return this.mode === 'shadow'; }

  /**
   * The new implementation of the read path, owned by this service.
   * Deliberately returns the same shape as the legacy endpoint.
   */
  async readWorkOrder(id: number) {
    const [wo] = await this.ds.query(
      `SELECT work_order_id, title, company, city, state, source, source_type,
              pay_type, pay_rate, duration_hours, status, posted_at, ingested_at,
              body_clean
         FROM work_orders WHERE work_order_id = $1`, [id]);
    if (!wo) return null;
    const attrs = await this.ds.query(
      `SELECT a.attribute_id AS id, a.attribute_type AS type, a.canonical_name AS name,
              wa.raw_value, wa.confidence, wa.resolved_by
         FROM work_order_attributes wa
         JOIN core_job_attributes a ON a.attribute_id = wa.attribute_id
        WHERE wa.work_order_id = $1 ORDER BY a.attribute_type`, [id]);
    return { ...wo, attributes: attrs };
  }

  /**
   * Compare the two implementations on the fields that matter.
   *
   * Comparing whole payloads produces noise -- timestamps serialise differently,
   * key order differs, floats format differently. Comparing the fields a caller
   * actually depends on is what makes divergence a signal rather than an alarm.
   */
  compare(id: number, legacy: any, next: any) {
    this.stats.shadow_compared++;
    const fields = ['title', 'company', 'city', 'state', 'status', 'source_type'];
    const diffs: any[] = [];

    for (const f of fields) {
      const a = legacy?.[f] ?? null, b = next?.[f] ?? null;
      if (String(a) !== String(b)) diffs.push({ field: f, legacy: a, new: b });
    }
    const la = (legacy?.attributes || []).map((x: any) => x.id).sort().join(',');
    const nb = (next?.attributes || []).map((x: any) => x.id).sort().join(',');
    if (la !== nb) diffs.push({ field: 'attributes', legacy: la, new: nb });

    shadowCmp.inc({ outcome: diffs.length ? 'diverged' : 'matched' });
    if (diffs.length) {
      this.stats.shadow_diverged++;
      this.stats.divergences.push({ work_order_id: id, at: new Date().toISOString(), diffs });
      if (this.stats.divergences.length > 50) this.stats.divergences.shift();
      this.log.warn(`divergence on work order ${id}: ${JSON.stringify(diffs)}`);
    } else {
      this.stats.shadow_matched++;
    }
    return diffs;
  }
}
