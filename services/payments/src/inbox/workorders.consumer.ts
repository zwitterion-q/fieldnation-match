import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Bus, Envelope } from '@fn/tsevents';
import { HoldsService } from '../holds/holds.service';

/** payments reacts to the work-order lifecycle. It is never called directly. */
@Injectable()
export class WorkOrdersConsumer implements OnModuleInit {
  private readonly log = new Logger('WorkOrdersConsumer');
  constructor(@InjectDataSource() private ds: DataSource, private holds: HoldsService) {}

  async onModuleInit() {
    const bus = await new Bus(process.env.RABBIT_URL ||
      'amqp://fn:fn@localhost:55672/%2F', 'payments').connect();

    await bus.subscribe(
      ['workorder.dispatched', 'workorder.accepted', 'workorder.rejected',
       'workorder.completed', 'workorder.cancelled'],
      (env) => this.route(env),
      {
        prefetch: 10,
        seen: async (id) => (await this.ds.query(
          `SELECT 1 FROM processed_messages WHERE message_id=$1`, [id])).length > 0,
        markSeen: async (id, type) => { await this.ds.query(
          `INSERT INTO processed_messages (message_id, event_type)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, type]); },
      });
  }

  private route(env: Envelope) {
    switch (env.type) {
      case 'workorder.dispatched': return this.holds.placeHold(env);
      case 'workorder.accepted':   return this.holds.confirmHold(env);
      case 'workorder.rejected':
      case 'workorder.cancelled':  return this.holds.releaseHold(env);
      case 'workorder.completed':  return this.holds.capture(env);
      default: this.log.warn(`unrouted ${env.type}`); return Promise.resolve();
    }
  }
}
