import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type AssignmentStatus =
  | 'dispatched' | 'accepted' | 'rejected' | 'expired'
  | 'cancelled' | 'submitted' | 'completed';

/**
 * One dispatch of one work order to one technician.
 *
 * A work order may be dispatched several times in sequence (rejected, then
 * offered to the next candidate), so assignment is its own entity rather than
 * columns on work_orders. The full offer history is then queryable, which is
 * what you need to answer "why did this job take three days to fill".
 */
@Entity('assignments')
@Index(['workOrderId', 'status'])
export class Assignment {
  @PrimaryGeneratedColumn() id: number;

  @Column({ name: 'work_order_id' }) workOrderId: number;
  @Column({ name: 'technician_id' }) technicianId: number;
  @Column({ name: 'hirer_user_id' }) hirerUserId: number;
  @Column({ name: 'buyer_company', nullable: true }) buyerCompany: string;

  @Column({ type: 'text', default: 'dispatched' }) status: AssignmentStatus;

  @Column({ name: 'match_score', type: 'float', nullable: true }) matchScore: number;
  @Column({ name: 'pay_rate', type: 'numeric', precision: 10, scale: 2, nullable: true }) payRate: string;
  @Column({ name: 'pay_type', nullable: true }) payType: string;
  @Column({ name: 'duration_hours', type: 'numeric', precision: 6, scale: 2, nullable: true }) durationHours: string;

  /** Offers expire so a work order cannot be held hostage by an idle technician. */
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true }) respondedAt: Date;
  @Column({ name: 'reject_reason', type: 'text', nullable: true }) rejectReason: string;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true }) submittedAt: Date;
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true }) approvedAt: Date;
  @Column({ name: 'hours_worked', type: 'numeric', precision: 6, scale: 2, nullable: true }) hoursWorked: string;
  @Column({ name: 'completion_note', type: 'text', nullable: true }) completionNote: string;

  /** Payment state observed from payment.* events -- work-orders does not own it. */
  @Column({ name: 'hold_state', type: 'text', default: 'none' }) holdState: string;

  @Column({ name: 'correlation_id', nullable: true }) correlationId: string;

  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
