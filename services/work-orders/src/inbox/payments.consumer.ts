import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Bus, Envelope } from '@fn/tsevents';
import { DispatchSaga } from '../saga/dispatch.saga';
import { Projector } from '../eventstore/projector.service';

/**
 * work-orders reacts to payment outcomes rather than calling payments.
 *
 * The hold state is mirrored onto the assignment as a read-model. work-orders
 * does not own it and never asks for it -- it learns by consuming.
 */
@Injectable()
export class PaymentsConsumer implements OnModuleInit {
  private readonly log = new Logger('PaymentsConsumer');
  constructor(@InjectDataSource() private ds: DataSource, private saga: DispatchSaga,
              private projector: Projector) {}

  async onModuleInit() {
    const bus = await new Bus(process.env.RABBIT_URL ||
      'amqp://fn:fn@localhost:55672/%2F', 'workorders').connect();

    await bus.subscribe(
      ['payment.hold_placed', 'payment.hold_released', 'payment.failed'],
      (env) => this.handle(env),
      {
        prefetch: 10,
        seen: async (id) => {
          const r = await this.ds.query(
            `SELECT 1 FROM processed_messages WHERE message_id = $1`, [id]);
          return r.length > 0;
        },
        markSeen: async (id, type) => {
          await this.ds.query(
            `INSERT INTO processed_messages (message_id, event_type)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, type]);
        },
      });
  }

  private async handle(env: Envelope) {
    const state = { 'payment.hold_placed': 'held',
                    'payment.hold_released': 'released',
                    'payment.failed': 'failed' }[env.type];
    const woId = env.payload.work_order_id;

    await this.ds.query(
      `UPDATE assignments SET hold_state = $1
        WHERE work_order_id = $2 AND status IN ('dispatched','accepted')`, [state, woId]);

    // A failed hold means the job is not really funded: pull the offer.
    if (env.type === 'payment.failed') {
      await this.ds.query(
        `UPDATE work_orders SET status='open' WHERE work_order_id=$1`, [woId]);
      this.log.warn(`hold failed for work order ${woId} — returned to pool`);
    }
    if (env.payload.assignment_id) {
      await this.ds.transaction(m =>
        this.projector.append(m, 'assignment', env.payload.assignment_id, env));
    }
    // Advance the orchestrated saga on the same event that drove the read model.
    await this.saga.onEvent(env);
    this.log.log(`${env.type} -> work order ${woId} hold_state=${state}`);
  }
}
