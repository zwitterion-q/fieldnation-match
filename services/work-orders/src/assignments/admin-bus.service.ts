import { Injectable, OnModuleInit } from '@nestjs/common';
import { Bus } from '@fn/tsevents';

/** Publishing side of the non-event exchanges: commands, broadcasts, priority. */
@Injectable()
export class AdminBusService implements OnModuleInit {
  private bus: Bus;

  async onModuleInit() {
    this.bus = await new Bus(process.env.RABBIT_URL ||
      'amqp://fn:fn@localhost:55672/%2F', 'workorders').connect();
  }

  /** Direct exchange: one recipient, exact-match routing key. */
  payoutCommand(technicianId: number, requestedBy: number) {
    return this.bus.sendCommand('payout.execute',
      { technician_id: technicianId, requested_by: requestedBy });
  }

  /** Fanout: five queues bound, all get a copy, routing key ignored. */
  async broadcastTaxonomyReload() {
    await this.bus.broadcast('platform.taxonomy_reload', { at: new Date().toISOString() });
    return 5;
  }

  /** Headers exchange: binding matches on attributes, not on a routing key. */
  flagPriority(workOrderId: number, priority: string, sla: string) {
    return this.bus.publishPriority({ work_order_id: workOrderId }, { priority, sla });
  }
}
