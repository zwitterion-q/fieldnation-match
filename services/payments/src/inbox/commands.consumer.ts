import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Bus, Envelope, commandQueue, broadcastQueue } from '@fn/tsevents';
import { HoldsService } from '../holds/holds.service';

/**
 * Commands and broadcasts, as distinct from events.
 *
 * `payout.execute` is a COMMAND: an instruction addressed to exactly one
 * service, which fails if nobody carries it out. It goes through the direct
 * exchange, not the topic one, because there is no sensible second consumer.
 *
 * Broadcasts are the opposite: fanout, every service gets a copy, and no
 * sender cares who acts on it.
 *
 * Prefetch is 1 here on purpose. Commands mutate money and are low volume --
 * there is nothing to gain from pipelining them, and a smaller in-flight window
 * means less to redeliver if this instance dies mid-command.
 */
@Injectable()
export class CommandsConsumer implements OnModuleInit {
  private readonly log = new Logger('Commands');
  constructor(private holds: HoldsService) {}

  async onModuleInit() {
    const bus = await new Bus(process.env.RABBIT_URL ||
      'amqp://fn:fn@localhost:55672/%2F', 'payments').connect();

    await bus.consumeQueue(commandQueue('payments', 'payout.execute'),
      async (env: Envelope) => {
        const { technician_id, requested_by } = env.payload;
        const r = await this.holds.payout(technician_id, requested_by ?? 0);
        this.log.log(`command payout.execute technician=${technician_id} → ${JSON.stringify(r)}`);
      }, 1);

    await bus.consumeQueue(broadcastQueue('payments'),
      async (env: Envelope) => {
        this.log.log(`broadcast ${env.type} received`);
      }, 5);
  }
}
