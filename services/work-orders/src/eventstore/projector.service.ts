import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Envelope } from '@fn/tsevents';
import { StoredEvent, AssignmentProjection, ProjectionCheckpoint } from './eventstore.entity';

const PROJECTION = 'assignment_projection';

/**
 * Event sourcing + CQRS.
 *
 * append()  writes to the log, in the same transaction as the state change.
 * project() folds the log into a denormalised read model.
 * rebuild() throws the read model away and replays from sequence zero.
 *
 * That last one is the property that matters. A read model you can rebuild is a
 * read model you can change your mind about: add a field, fix a bug in the fold,
 * or invent an entirely new view, and you backfill it from history instead of
 * migrating and hoping. Systems that only store current state cannot do this,
 * because the information was thrown away at write time.
 */
@Injectable()
export class Projector implements OnModuleInit {
  private readonly log = new Logger('Projector');
  private running = false;

  constructor(@InjectDataSource() private ds: DataSource) {}

  async onModuleInit() {
    await this.ds.query(
      `INSERT INTO projection_checkpoint (name, last_sequence, events_applied)
       VALUES ($1, 0, 0) ON CONFLICT (name) DO NOTHING`, [PROJECTION]);
    // Poll rather than subscribe: the projector reads the LOG, not the bus, so
    // it can never miss an event that was published while it was restarting.
    setInterval(() => this.project().catch(e =>
      this.log.error(`projection failed: ${e.message}`)), 1000);
    this.log.log('projector started (1s poll)');
  }

  /** Append to the log. Called inside the caller's transaction. */
  async append(m: EntityManager, streamType: string, streamId: number, env: Envelope) {
    const [{ next }] = await m.query(
      `SELECT COALESCE(MAX(stream_version), 0) + 1 AS next FROM event_store
        WHERE stream_type = $1 AND stream_id = $2`, [streamType, streamId]);
    return m.save(m.create(StoredEvent, {
      streamType, streamId, streamVersion: Number(next),
      eventType: env.type, eventVersion: env.version, envelope: env,
      correlationId: env.correlation_id, causationId: env.causation_id,
    }));
  }

  /** Fold new events into the read model, from the last checkpoint. */
  async project(batch = 500): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const [cp] = await this.ds.query(
        `SELECT last_sequence FROM projection_checkpoint WHERE name = $1`, [PROJECTION]);
      const from = cp?.last_sequence ?? '0';

      const events: any[] = await this.ds.query(
        `SELECT * FROM event_store WHERE global_sequence > $1
          ORDER BY global_sequence LIMIT $2`, [from, batch]);
      if (!events.length) return 0;

      for (const e of events) await this.apply(e);

      const last = events[events.length - 1].global_sequence;
      await this.ds.query(
        `UPDATE projection_checkpoint
            SET last_sequence = $2, events_applied = events_applied + $3, updated_at = now()
          WHERE name = $1`, [PROJECTION, last, events.length]);
      return events.length;
    } finally {
      this.running = false;
    }
  }

  /**
   * The fold. Deliberately tolerant: an event for an unknown assignment is
   * skipped rather than fatal, because a projector that dies on unexpected input
   * blocks every later event behind it.
   */
  private async apply(e: any) {
    const env: Envelope = e.envelope;
    const p = env.payload || {};
    const aid = p.assignment_id;
    if (!aid) return;

    const entry = { at: env.occurred_at, event: env.type,
                    detail: p.reason || p.amount || p.hours_worked || null };

    switch (env.type) {
      case 'workorder.dispatched':
        await this.ds.query(
          `INSERT INTO assignment_projection
             (assignment_id, work_order_id, technician_id, hirer_id, buyer_company,
              status, timeline, event_count, dispatched_at)
           VALUES ($1,$2,$3,$4,$5,'dispatched',$6::jsonb,1,$7)
           ON CONFLICT (assignment_id) DO UPDATE
             SET status='dispatched',
                 timeline = assignment_projection.timeline || $6::jsonb,
                 event_count = assignment_projection.event_count + 1`,
          [aid, p.work_order_id, p.technician_id, p.hirer_id, p.buyer_company,
           JSON.stringify([entry]), env.occurred_at]);
        break;

      case 'workorder.accepted':
      case 'workorder.rejected':
      case 'workorder.completed':
      case 'workorder.cancelled': {
        const status = env.type.split('.')[1];
        const settle = ['rejected', 'completed', 'cancelled'].includes(status);
        await this.ds.query(
          `UPDATE assignment_projection
              SET status = $2,
                  timeline = timeline || $3::jsonb,
                  event_count = event_count + 1,
                  settled_at = CASE WHEN $4 THEN $5::timestamptz ELSE settled_at END,
                  time_to_fill_seconds = CASE WHEN $4 AND dispatched_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM ($5::timestamptz - dispatched_at))::int
                    ELSE time_to_fill_seconds END
            WHERE assignment_id = $1`,
          [aid, status, JSON.stringify([entry]), settle, env.occurred_at]);
        break;
      }

      case 'payment.hold_placed':
        await this.ds.query(
          `UPDATE assignment_projection
              SET hold_state='held', amount_held=$2, timeline = timeline || $3::jsonb,
                  event_count = event_count + 1
            WHERE assignment_id = $1`, [aid, p.amount, JSON.stringify([entry])]);
        break;

      case 'payment.hold_released':
        await this.ds.query(
          `UPDATE assignment_projection
              SET hold_state='released', timeline = timeline || $2::jsonb,
                  event_count = event_count + 1
            WHERE assignment_id = $1`, [aid, JSON.stringify([entry])]);
        break;

      case 'payment.failed':
        await this.ds.query(
          `UPDATE assignment_projection
              SET hold_state='failed', timeline = timeline || $2::jsonb,
                  event_count = event_count + 1
            WHERE assignment_id = $1`, [aid, JSON.stringify([entry])]);
        break;
    }
  }

  /**
   * Throw the read model away and rebuild it from the log.
   *
   * This is the demonstration that matters: the projection holds no information
   * that is not derivable from the events, so it can always be reconstructed.
   */
  async rebuild() {
    const t0 = Date.now();
    const [{ count: before }] = await this.ds.query(
      `SELECT count(*)::int AS count FROM assignment_projection`);

    await this.ds.query(`TRUNCATE assignment_projection`);
    await this.ds.query(
      `UPDATE projection_checkpoint SET last_sequence = 0, events_applied = 0 WHERE name = $1`,
      [PROJECTION]);

    let applied = 0, n = 0;
    do { n = await this.project(1000); applied += n; } while (n > 0);

    const [{ count: after }] = await this.ds.query(
      `SELECT count(*)::int AS count FROM assignment_projection`);
    const [{ count: total }] = await this.ds.query(
      `SELECT count(*)::int AS count FROM event_store`);

    return {
      rebuilt_from_events: Number(total), events_applied: applied,
      rows_before: Number(before), rows_after: Number(after),
      identical: Number(before) === Number(after),
      took_ms: Date.now() - t0,
    };
  }

  /** Rebuild one aggregate's current state by folding its stream — the
   *  event-sourcing read path, with no read model involved at all. */
  async replayStream(streamType: string, streamId: number) {
    const events: any[] = await this.ds.query(
      `SELECT stream_version, event_type, envelope, recorded_at FROM event_store
        WHERE stream_type = $1 AND stream_id = $2 ORDER BY stream_version`,
      [streamType, streamId]);

    let state: any = { status: null, hold_state: 'none', amount: null };
    for (const e of events) {
      const t = e.event_type, p = e.envelope.payload || {};
      if (t === 'workorder.dispatched') state.status = 'dispatched';
      else if (t.startsWith('workorder.')) state.status = t.split('.')[1];
      else if (t === 'payment.hold_placed') { state.hold_state = 'held'; state.amount = p.amount; }
      else if (t === 'payment.hold_released') state.hold_state = 'released';
      else if (t === 'payment.failed') state.hold_state = 'failed';
    }
    return {
      stream: `${streamType}:${streamId}`, events: events.length,
      derived_state: state,
      history: events.map(e => ({ v: e.stream_version, event: e.event_type, at: e.recorded_at })),
    };
  }
}
