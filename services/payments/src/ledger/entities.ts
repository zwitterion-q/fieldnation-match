import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm';

export type AccountKind = 'asset' | 'liability' | 'revenue';
export type Direction = 'debit' | 'credit';

/**
 * Accounts are held from the PLATFORM's perspective.
 *
 *   hirer_funds        liability — money a hirer has deposited that we owe back
 *   escrow             liability — funds committed to a specific work order
 *   technician_payable liability — earned but not yet paid out
 *   platform_revenue   revenue   — our fee
 *   cash               asset     — what actually sits in the bank
 *
 * Modelling a marketplace balance as a single mutable number is the classic
 * mistake: you can see what someone has, but never how they got there, and a
 * bug silently rewrites history. Ledger entries are append-only, so a balance
 * is always derivable and always explainable.
 */
@Entity('accounts')
@Index(['ownerType', 'ownerId', 'code'], { unique: true })
export class Account {
  @PrimaryGeneratedColumn() id: number;
  @Column() code: string;                                   // hirer_funds | escrow | ...
  @Column({ name: 'owner_type' }) ownerType: string;        // hirer | technician | platform
  @Column({ name: 'owner_id', type: 'int', nullable: true }) ownerId: number;
  @Column({ type: 'text' }) kind: AccountKind;
  @Column({ default: 'USD' }) currency: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

/** A balanced set of entries. Debits must equal credits — checked in code and
 *  again by a database constraint, because an unbalanced ledger is corruption. */
@Entity('ledger_transactions')
export class LedgerTransaction {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'ref_type' }) refType: string;            // work_order | deposit
  @Column({ name: 'ref_id', type: 'int', nullable: true }) refId: number;
  @Column({ type: 'text' }) description: string;
  @Column({ name: 'correlation_id', nullable: true }) correlationId: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('ledger_entries')
@Index(['accountId'])
export class LedgerEntry {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'transaction_id' }) transactionId: number;
  @Column({ name: 'account_id' }) accountId: number;
  @Column({ type: 'text' }) direction: Direction;
  /** Stored in minor units (cents). Floating point has no place in money. */
  @Column({ type: 'bigint' }) amount: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;

  @ManyToOne(() => LedgerTransaction) @JoinColumn({ name: 'transaction_id' })
  transaction: LedgerTransaction;
}

export type HoldState = 'placed' | 'confirmed' | 'released' | 'captured';

/**
 * A payout moves earned money OFF the platform.
 *
 * Capture credits technician_payable -- a liability, money we owe but still
 * hold. Only a payout discharges it, debiting the liability and crediting cash.
 * Keeping those two steps distinct is the difference between "earned" and
 * "paid", which is a question every marketplace technician asks.
 */
@Entity('payouts')
export class Payout {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'technician_id' }) technicianId: number;
  @Column({ type: 'bigint' }) amount: string;
  @Column({ type: 'text', default: 'paid' }) state: string;
  @Column({ name: 'reference', nullable: true }) reference: string;
  @Column({ name: 'requested_by', type: 'int', nullable: true }) requestedBy: number;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('holds')
@Index(['workOrderId'])
// One hold per assignment, enforced by the database rather than by application
// logic. Events for different assignments arrive on different queues and are
// therefore delivered CONCURRENTLY -- two dispatches racing would otherwise both
// see "no existing hold" and both post to the ledger. A unique constraint makes
// that outcome impossible regardless of arrival order.
@Index(['assignmentId'], { unique: true })
export class Hold {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'work_order_id' }) workOrderId: number;
  @Column({ name: 'assignment_id' }) assignmentId: number;
  @Column({ name: 'hirer_id' }) hirerId: number;
  @Column({ name: 'technician_id', type: 'int', nullable: true }) technicianId: number;
  @Column({ type: 'bigint' }) amount: string;
  @Column({ type: 'text', default: 'placed' }) state: HoldState;
  @Column({ name: 'correlation_id', nullable: true }) correlationId: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
