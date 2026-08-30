import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/** Idempotency ledger. At-least-once delivery guarantees duplicates; this is
 *  what stops a replayed event applying twice. */
@Entity('processed_messages')
export class ProcessedMessage {
  @PrimaryColumn({ name: 'message_id' }) messageId: string;
  @Column({ name: 'event_type' }) eventType: string;
  @CreateDateColumn({ name: 'processed_at' }) processedAt: Date;
}
