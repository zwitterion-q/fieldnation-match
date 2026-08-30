import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Account, LedgerEntry, LedgerTransaction, AccountKind } from './entities';

export interface Posting { accountId: number; direction: 'debit' | 'credit'; amount: bigint }

/** Liability and revenue accounts increase on credit; assets increase on debit. */
const INCREASES_ON_CREDIT: AccountKind[] = ['liability', 'revenue'];

@Injectable()
export class LedgerService {
  constructor(@InjectDataSource() private ds: DataSource) {}

  async account(m: EntityManager, code: string, ownerType: string,
                ownerId: number | null, kind: AccountKind): Promise<Account> {
    let a = await m.findOne(Account, { where: { code, ownerType, ownerId } });
    if (!a) a = await m.save(m.create(Account, { code, ownerType, ownerId, kind }));
    return a;
  }

  /**
   * Post a balanced transaction. Rejects if debits != credits — the single
   * invariant the whole ledger rests on.
   */
  async post(m: EntityManager, refType: string, refId: number, description: string,
             postings: Posting[], correlationId?: string): Promise<LedgerTransaction> {
    const debits  = postings.filter(p => p.direction === 'debit').reduce((s, p) => s + p.amount, 0n);
    const credits = postings.filter(p => p.direction === 'credit').reduce((s, p) => s + p.amount, 0n);
    if (debits !== credits) {
      throw new BadRequestException(`unbalanced transaction: debits ${debits} != credits ${credits}`);
    }
    if (debits === 0n) throw new BadRequestException('zero-value transaction');

    const tx = await m.save(m.create(LedgerTransaction, {
      refType, refId, description, correlationId }));
    for (const p of postings) {
      await m.save(m.create(LedgerEntry, {
        transactionId: tx.id, accountId: p.accountId,
        direction: p.direction, amount: p.amount.toString() }));
    }
    return tx;
  }

  /** Balance derived from entries, never stored. */
  async balance(m: EntityManager, accountId: number): Promise<bigint> {
    const [row] = await m.query(
      `SELECT
         COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE 0 END),0) AS cr,
         COALESCE(SUM(CASE WHEN direction='debit'  THEN amount ELSE 0 END),0) AS dr
       FROM ledger_entries WHERE account_id = $1`, [accountId]);
    const a = await m.findOne(Account, { where: { id: accountId } });
    const cr = BigInt(row.cr), dr = BigInt(row.dr);
    return INCREASES_ON_CREDIT.includes(a.kind) ? cr - dr : dr - cr;
  }

  async statement(hirerId: number) {
    return this.ds.query(
      `SELECT t.id, t.created_at, t.description, t.ref_type, t.ref_id,
              a.code AS account, e.direction, e.amount
         FROM ledger_entries e
         JOIN accounts a ON a.id = e.account_id
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE (a.owner_type='hirer' AND a.owner_id=$1)
           OR (a.code='escrow' AND t.ref_id IN (
                 SELECT work_order_id FROM holds WHERE hirer_id=$1))
        ORDER BY t.id DESC, e.id LIMIT 200`, [hirerId]);
  }
}
