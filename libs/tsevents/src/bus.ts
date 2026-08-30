import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import { Envelope } from './envelope';
import {
  EX_EVENTS, EX_RETRY, EX_PARKING, EX_COMMANDS, EX_BROADCAST, EX_PRIORITY,
  TIERS, MAX_ATTEMPTS, ATTEMPT_HEADER, deathCount,
  mainQueue, commandQueue, broadcastQueue, retryRoutingKey, parkingRoutingKey,
} from './topology';

export type Handler = (env: Envelope) => Promise<void>;
/** Returns true if this message id has already been handled. */
export type SeenCheck = (messageId: string, eventType: string) => Promise<boolean>;
/** Records a message id as handled, inside the handler's own transaction ideally. */
export type MarkSeen = (messageId: string, eventType: string) => Promise<void>;

export class Bus {
  private conn: amqp.ChannelModel | null;
  private pubCh: amqp.ConfirmChannel | null;
  private subCh: amqp.Channel | null;

  constructor(private url: string, private service: string) {}

  async connect() {
    this.conn = await amqp.connect(this.url, { heartbeat: 30 });
    this.conn.on('error', e => console.error('[bus] connection error:', e.message));
    this.conn.on('close', () => { this.conn = null; this.pubCh = null; this.subCh = null; });
    // Confirm channel: publishes are only considered done once the broker acks.
    this.pubCh = await this.conn.createConfirmChannel();
    this.subCh = await this.conn.createChannel();
    for (const [name, ch] of [['pub', this.pubCh], ['sub', this.subCh]] as const) {
      ch.on('error', (e: any) => console.error(`[bus] ${name} channel error:`, e.message));
      ch.on('close', () => console.warn(`[bus] ${name} channel closed`));
    }
    return this;
  }

  /**
   * A channel can close without the connection dying -- an unroutable mandatory
   * publish, a broker restart, a protocol error on an unrelated operation. When
   * that happens the original code kept publishing into a dead channel forever:
   * the outbox relay logged "Channel closed" 26 times and never recovered, which
   * is silent data loss wearing a retry counter.
   *
   * Every publish now checks liveness first and rebuilds if needed.
   */
  private async ensurePublishChannel(): Promise<amqp.ConfirmChannel> {
    if (this.pubCh && (this.pubCh as any).connection && !(this.pubCh as any).closed) {
      return this.pubCh;
    }
    console.warn('[bus] publish channel unusable — reconnecting');
    try { await this.conn?.close(); } catch { /* already gone */ }
    this.conn = null; this.pubCh = null; this.subCh = null;
    await this.connect();
    return this.pubCh;
  }

  /** Publish with confirms. Rejects if the broker does not ack, so the outbox
   *  relay leaves the row unsent and retries rather than losing the event. */
  async publish(env: Envelope): Promise<void> {
    const ch = await this.ensurePublishChannel();
    await new Promise<void>((resolve, reject) => {
      ch.publish(
        EX_EVENTS, env.type, Buffer.from(JSON.stringify(env)),
        { persistent: true, contentType: 'application/json',
          messageId: env.id, correlationId: env.correlation_id,
          headers: { [ATTEMPT_HEADER]: 0 } },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  /**
   * Send a COMMAND. Direct exchange, exact-match routing key, exactly one
   * consumer. Unlike an event, a command that reaches nobody is an error --
   * mandatory:true makes the broker return it rather than silently dropping it.
   */
  async sendCommand(command: string, payload: any, correlationId?: string): Promise<void> {
    const ch = await this.ensurePublishChannel();
    const env = { id: randomUUID(), type: command, version: 1,
                  occurred_at: new Date().toISOString(),
                  correlation_id: correlationId ?? randomUUID(),
                  causation_id: null, actor: null, payload };
    await new Promise<void>((resolve, reject) => {
      ch.publish(EX_COMMANDS, command, Buffer.from(JSON.stringify(env)),
        { persistent: true, contentType: 'application/json', messageId: env.id,
          mandatory: true, headers: { [ATTEMPT_HEADER]: 0 } },
        (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Fanout. Every bound queue gets a copy; the routing key is ignored. */
  async broadcast(type: string, payload: any): Promise<void> {
    const ch = await this.ensurePublishChannel();
    const env = { id: randomUUID(), type, version: 1,
                  occurred_at: new Date().toISOString(),
                  correlation_id: randomUUID(), causation_id: null, actor: null, payload };
    await new Promise<void>((resolve, reject) => {
      ch.publish(EX_BROADCAST, '', Buffer.from(JSON.stringify(env)),
        { persistent: true, contentType: 'application/json', messageId: env.id },
        (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Headers exchange. Routing is decided by message ATTRIBUTES, so a work order
   * can be urgent regardless of which event type it is -- no routing-key
   * explosion across the cross-product of event x SLA.
   */
  async publishPriority(payload: any, attrs: Record<string, string>): Promise<void> {
    const ch = await this.ensurePublishChannel();
    const env = { id: randomUUID(), type: 'workorder.priority', version: 1,
                  occurred_at: new Date().toISOString(),
                  correlation_id: randomUUID(), causation_id: null, actor: null, payload };
    await new Promise<void>((resolve, reject) => {
      ch.publish(EX_PRIORITY, '', Buffer.from(JSON.stringify(env)),
        { persistent: true, contentType: 'application/json', headers: attrs },
        (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Consume commands (direct) or broadcasts (fanout) with the same contract. */
  async consumeQueue(queue: string, handler: Handler, prefetch = 10) {
    await this.subCh.prefetch(prefetch);
    await this.subCh.consume(queue, async (msg) => {
      if (!msg) return;
      try {
        await handler(JSON.parse(msg.content.toString()));
        this.subCh.ack(msg);
      } catch (e: any) {
        console.error(`[bus] ${queue} handler failed: ${e.message}`);
        this.subCh.nack(msg, false, false);   // straight to DLX, no requeue loop
      }
    });
    console.log(`[bus] consuming ${queue}`);
  }

  /**
   * Subscribe with the shared retry contract.
   *
   * On failure the consumer does NOT nack -- it republishes itself to the next
   * retry tier and acks the original. Nack-driven dead-lettering can only route
   * to one fixed destination, so it cannot pick a tier.
   */
  async subscribe(events: string[], handler: Handler,
                  opts: { prefetch?: number; seen?: SeenCheck; markSeen?: MarkSeen } = {}) {
    await this.subCh.prefetch(opts.prefetch ?? 20);

    for (const event of events) {
      const q = mainQueue(this.service, event);
      await this.subCh.consume(q, async (msg) => {
        if (!msg) return;
        // Trust whichever counter is higher. Our own header tracks the retry
        // ladder; x-death is written by the broker and also catches messages
        // dead-lettered by TTL or queue-length limits, which our header misses.
        const ours = Number(msg.properties.headers?.[ATTEMPT_HEADER] ?? 0);
        const broker = deathCount(msg.properties.headers);
        const attempt = Math.max(ours, broker);
        let env: Envelope;
        try {
          env = JSON.parse(msg.content.toString());
        } catch {
          this.subCh.publish(EX_PARKING, `${this.service}.unparseable`, msg.content,
            { persistent: true, headers: { [ATTEMPT_HEADER]: 99 } });
          this.subCh.ack(msg);
          return;
        }

        // At-least-once delivery makes duplicates normal, not exceptional.
        if (opts.seen && await opts.seen(env.id, env.type)) {
          this.subCh.ack(msg);
          return;
        }

        try {
          await handler(env);
          if (opts.markSeen) await opts.markSeen(env.id, env.type);
          this.subCh.ack(msg);
        } catch (e: any) {
          if (attempt >= MAX_ATTEMPTS) {
            console.error(`[bus] ${env.type} ${env.id} failed ${attempt}x — parking: ${e.message}`);
            this.subCh.publish(EX_PARKING, parkingRoutingKey(this.service, env.type),
              msg.content, { persistent: true, headers: { [ATTEMPT_HEADER]: attempt } });
          } else {
            const tier = TIERS[attempt];
            console.warn(`[bus] ${env.type} ${env.id} failed (attempt ${attempt + 1}) — retry via ${tier}: ${e.message}`);
            this.subCh.publish(EX_RETRY, retryRoutingKey(this.service, tier, env.type),
              msg.content, { persistent: true, headers: { [ATTEMPT_HEADER]: attempt + 1 } });
          }
          this.subCh.ack(msg);
        }
      });
      console.log(`[bus] consuming ${q}`);
    }
  }

  async close() { await this.conn?.close(); }
}
