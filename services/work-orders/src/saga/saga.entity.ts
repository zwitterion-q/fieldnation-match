import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type SagaStatus =
  | 'running' | 'completed' | 'compensating' | 'compensated' | 'failed';
export type StepStatus = 'pending' | 'completed' | 'failed' | 'compensated';

/**
 * An orchestrated saga instance.
 *
 * The choreographed version of this flow already works -- services react to
 * events with no coordinator. Its one real weakness, recorded in ADR-03, is that
 * no single place shows where a business transaction has got to; you reconstruct
 * it from correlation ids in the logs.
 *
 * This is the answer to that: explicit state, explicit steps, explicit
 * compensations. The cost is coupling -- the orchestrator has to know the shape
 * of the whole flow, which is exactly what choreography avoids.
 *
 * Both run side by side here on purpose, because the interesting question is
 * not which is better but when each is right.
 */
@Entity('saga_instances')
@Index(['correlationId'])
export class SagaInstance {
  @PrimaryGeneratedColumn() id: number;

  @Column({ name: 'saga_type' }) sagaType: string;
  @Column({ name: 'correlation_id' }) correlationId: string;
  @Column({ name: 'work_order_id', type: 'int', nullable: true }) workOrderId: number;
  @Column({ name: 'assignment_id', type: 'int', nullable: true }) assignmentId: number;

  @Column({ type: 'text', default: 'running' }) status: SagaStatus;
  @Column({ name: 'current_step', type: 'text', nullable: true }) currentStep: string;

  /** Everything the saga needs to compensate later, captured as it goes. */
  @Column({ type: 'jsonb', default: {} }) context: any;

  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError: string;
  @CreateDateColumn({ name: 'started_at' }) startedAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true }) completedAt: Date;
}

@Entity('saga_steps')
@Index(['sagaId'])
export class SagaStep {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'saga_id' }) sagaId: number;
  @Column({ name: 'step_name' }) stepName: string;
  @Column({ type: 'int' }) position: number;
  @Column({ type: 'text', default: 'pending' }) status: StepStatus;
  @Column({ name: 'compensatable', default: false }) compensatable: boolean;
  @Column({ type: 'text', nullable: true }) detail: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @Column({ name: 'settled_at', type: 'timestamptz', nullable: true }) settledAt: Date;
}
