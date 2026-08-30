import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Append-only event log — the event-sourcing half of the system.
 *
 * The assignments table holds current state, which is fast to query and
 * impossible to interrogate: it can tell you an offer was rejected, never that
 * it was dispatched at 14:02, funded at 14:02, and declined at 14:09 because the
 * technician was already booked.
 *
 * This log is the record of what HAPPENED. State is a fold over it, and any
 * read model can be thrown away and rebuilt from here.
 *
 * `global_sequence` is the primary key on purpose: replay must be deterministic,
 * and ordering by timestamp is not — two events in the same millisecond have no
 * defined order, and clocks move backwards.
 */
@Entity('event_store')
@Index(['streamType', 'streamId'])
@Index(['eventType'])
export class StoredEvent {
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'global_sequence' }) globalSequence: string;

  @Column({ name: 'stream_type' }) streamType: string;      // assignment | work_order
  @Column({ name: 'stream_id' }) streamId: number;
  @Column({ name: 'stream_version' }) streamVersion: number; // nth event for this stream

  @Column({ name: 'event_type' }) eventType: string;
  @Column({ name: 'event_version', default: 1 }) eventVersion: number;
  @Column({ type: 'jsonb' }) envelope: any;

  @Column({ name: 'correlation_id', nullable: true }) correlationId: string;
  @Column({ name: 'causation_id', nullable: true }) causationId: string;
  @CreateDateColumn({ name: 'recorded_at' }) recordedAt: Date;
}

/**
 * The read side of CQRS. Denormalised, disposable, rebuildable.
 *
 * Nothing writes here except the projector. If it is wrong, you delete it and
 * replay -- which is the property that makes read models cheap to change. Adding
 * a column to a normalised schema is a migration; adding one here is a rebuild.
 */
@Entity('assignment_projection')
export class AssignmentProjection {
  @PrimaryGeneratedColumn({ name: 'assignment_id' }) assignmentId: number;

  @Column({ name: 'work_order_id' }) workOrderId: number;
  @Column({ name: 'technician_id' }) technicianId: number;
  @Column({ name: 'hirer_id', nullable: true }) hirerId: number;
  @Column({ name: 'buyer_company', nullable: true }) buyerCompany: string;
  @Column({ type: 'text' }) status: string;
  @Column({ name: 'hold_state', type: 'text', default: 'none' }) holdState: string;

  @Column({ name: 'amount_held', type: 'numeric', precision: 12, scale: 2, nullable: true })
  amountHeld: string;

  /** The whole history, denormalised for display. This is the answer to
   *  "why did this job take three days to fill" in one row. */
  @Column({ type: 'jsonb', default: [] }) timeline: any[];

  @Column({ name: 'event_count', default: 0 }) eventCount: number;
  @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true }) dispatchedAt: Date;
  @Column({ name: 'settled_at', type: 'timestamptz', nullable: true }) settledAt: Date;
  @Column({ name: 'time_to_fill_seconds', type: 'int', nullable: true }) timeToFillSeconds: number;
}

/** Checkpoint. A projector that forgets where it was replays everything. */
@Entity('projection_checkpoint')
export class ProjectionCheckpoint {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) name: string;
  @Column({ name: 'last_sequence', type: 'bigint', default: 0 }) lastSequence: string;
  @Column({ name: 'events_applied', default: 0 }) eventsApplied: number;
  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true }) updatedAt: Date;
}
