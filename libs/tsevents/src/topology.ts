/** Names of the topology declared in infra/rabbitmq/definitions.json.
 *  Nothing here creates anything -- services only reference. */
/**
 * One exchange type per job, chosen for routing semantics rather than habit.
 *
 *   events    topic    domain facts. Many consumers, pattern-matched routing.
 *   commands  direct   an instruction to ONE service. Exact-match, point-to-point.
 *   broadcast fanout   every service needs a copy; the routing key is ignored.
 *   priority  headers  routes on message ATTRIBUTES. Urgency is a property of a
 *                      work order, not a kind of event, so encoding it in the
 *                      routing key would multiply the key space by every SLA.
 *
 * The events/commands split matters: an event is a statement of fact that
 * already happened and anyone may care about. A command is an instruction that
 * one service must carry out, and it fails if nobody does. Different semantics,
 * different exchange type.
 */
export const EX_EVENTS  = 'fieldnation.events';
export const EX_COMMANDS  = 'fieldnation.commands';
export const EX_BROADCAST = 'fieldnation.broadcast';
export const EX_PRIORITY  = 'fieldnation.priority';
export const EX_RETRY   = 'fieldnation.retry';
export const EX_REQUEUE = 'fieldnation.requeue';
export const EX_PARKING = 'fieldnation.parking';

export const TIERS = ['r1', 'r2', 'r3'] as const;
export const TIER_DELAY_MS: Record<string, number> = { r1: 5_000, r2: 30_000, r3: 300_000 };
export const MAX_ATTEMPTS = TIERS.length;
export const ATTEMPT_HEADER = 'x-fn-attempt';

/** Broker-populated death record. Present whenever a message has been
 *  dead-lettered, and the authoritative count of how often. */
export interface XDeathEntry {
  count: number; reason: string; queue: string;
  exchange: string; 'routing-keys': string[]; time?: any;
}

/**
 * Total redeliveries the BROKER has recorded, independent of our own header.
 *
 * x-death is written by RabbitMQ itself, so it survives a consumer that forgets
 * to propagate application headers -- and it catches poison messages that were
 * dead-lettered by TTL or queue-length limits rather than by our retry path.
 * We take the max of the two counters so neither can be gamed.
 */
export function deathCount(headers: any): number {
  const xd: XDeathEntry[] = headers?.['x-death'] || [];
  return xd.reduce((n, d) => n + Number(d.count || 0), 0);
}

export const mainQueue = (service: string, event: string) => `q.${service}.${event}`;
export const commandQueue = (service: string, command: string) => `q.${service}.cmd.${command}`;
export const broadcastQueue = (service: string) => `q.${service}.broadcast`;

/** Lands in q.<svc>.retry.<tier>, dead-letters to fieldnation.requeue preserving
 *  this key, where the main queue is bound on '<svc>.*.<event>'. */
export const retryRoutingKey = (service: string, tier: string, event: string) =>
  `${service}.${tier}.${event}`;

export const parkingRoutingKey = (service: string, event: string) => `${service}.${event}`;
