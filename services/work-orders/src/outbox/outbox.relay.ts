import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Bus } from '@fn/tsevents';

/**
 * Reads unpublished outbox rows and puts them on the bus.
 *
 * Deliberately at-least-once: a row is marked published only AFTER the broker
 * confirms. If the relay dies between publishing and marking, the event is sent
 * twice — which is exactly why every consumer is idempotent. The alternative,
 * marking first, risks losing the event entirely, and losing is worse than
 * duplicating.
 *
 * FOR UPDATE SKIP LOCKED lets several relay replicas run without publishing the
 * same row twice.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OutboxRelay');
  private timer: NodeJS.Timeout;
  private bus: Bus;
  private running = false;

  constructor(@InjectDataSource() private ds: DataSource) {}

  async onModuleInit() {
    this.bus = await new Bus(process.env.RABBIT_URL ||
      'amqp://fn:fn@localhost:55672/%2F', 'workorders').connect();
    this.timer = setInterval(() => this.drain().catch(e =>
      this.log.error(`drain failed: ${e.message}`)), 1000);
    this.log.log('outbox relay started (1s poll)');
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.bus?.close();
  }

  async drain(batch = 50) {
    if (this.running) return 0;          // never overlap polls
    this.running = true;
    try {
      const rows = await this.ds.query(
        `SELECT id, event_type, envelope FROM outbox
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`, [batch]);

      let sent = 0;
      for (const row of rows) {
        try {
          await this.bus.publish(row.envelope);       // waits for broker confirm
          await this.ds.query(`UPDATE outbox SET published_at = now() WHERE id = $1`, [row.id]);
          sent++;
        } catch (e: any) {
          await this.ds.query(
            `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
            [row.id, e.message]);
          this.log.warn(`publish failed for outbox#${row.id}: ${e.message}`);
        }
      }
      if (sent) this.log.log(`published ${sent} event(s)`);
      return sent;
    } finally {
      this.running = false;
    }
  }
}
