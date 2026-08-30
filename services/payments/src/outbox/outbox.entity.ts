import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * The transactional outbox.
 *
 * A dispatch must do two things: change state in Postgres and publish to
 * RabbitMQ. Those cannot share a transaction. Writing the event here inside the
 * SAME transaction as the state change means either both land or neither does;
 * a relay publishes afterwards. This removes the half-state where a technician
 * is assigned but never told, or told about a job that was rolled back.
 */
@Entity('outbox')
export class OutboxMessage {
  @PrimaryGeneratedColumn() id: number;

  @Column({ name: 'event_type' }) eventType: string;
  @Column({ type: 'jsonb' }) envelope: any;

  @Index()
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true }) publishedAt: Date;
  @Column({ name: 'attempts', default: 0 }) attempts: number;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError: string;

  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
