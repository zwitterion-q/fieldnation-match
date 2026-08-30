import { Controller, Get, Post, Body, Param, Query, Req, ParseIntPipe, HttpCode } from '@nestjs/common';
import { IsInt } from 'class-validator';
import { HoldsService } from '../holds/holds.service';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LedgerService } from './ledger.service';
import { Public, RequirePermissions } from '../auth/jwt.strategy';
import { P } from '../auth/permissions';

class PayoutDto { @IsInt() technician_id: number; }

@Controller()
export class LedgerController {
  constructor(@InjectDataSource() private ds: DataSource,
              private ledger: LedgerService,
              private holdsSvc: HoldsService) {}

  @Public() @Get('health')
  health() { return { service: 'payments', status: 'ok' }; }

  /** Every account with its derived balance. Nothing here is a stored total. */
  @Get('ledger/accounts') @RequirePermissions(P.LEDGER_VIEW)
  async accounts() {
    return this.ds.query(
      `SELECT a.id, a.code, a.owner_type, a.owner_id, a.kind,
              ROUND((COALESCE(SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE 0 END),0)
                   - COALESCE(SUM(CASE WHEN e.direction='debit'  THEN e.amount ELSE 0 END),0))
                   * CASE WHEN a.kind IN ('liability','revenue') THEN 1 ELSE -1 END / 100.0, 2) AS balance
         FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
        GROUP BY a.id ORDER BY a.owner_type, a.code`);
  }

  /** Proves the invariant holds across the whole ledger. */
  @Get('ledger/trial-balance') @RequirePermissions(P.LEDGER_VIEW)
  async trialBalance() {
    const [r] = await this.ds.query(
      `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount ELSE 0 END),0) AS debits,
              COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE 0 END),0) AS credits
         FROM ledger_entries`);
    const debits = Number(r.debits) / 100, credits = Number(r.credits) / 100;
    return { debits, credits, balanced: debits === credits,
             note: 'every transaction posts equal debits and credits; this must always balance' };
  }

  @Get('ledger/transactions') @RequirePermissions(P.LEDGER_VIEW)
  transactions(@Query('limit') limit = '50') {
    return this.ds.query(
      `SELECT t.id, t.created_at, t.description, t.ref_type, t.ref_id, t.correlation_id,
              json_agg(json_build_object('account', a.code, 'owner', a.owner_id,
                       'direction', e.direction, 'amount', e.amount::bigint/100.0)
                       ORDER BY e.id) AS entries
         FROM ledger_transactions t
         JOIN ledger_entries e ON e.transaction_id = t.id
         JOIN accounts a ON a.id = e.account_id
        GROUP BY t.id ORDER BY t.id DESC LIMIT $1`, [Number(limit)]);
  }

  /** Only finance and admin hold payment:release. */
  @Post('payouts') @HttpCode(200) @RequirePermissions(P.PAYMENT_RELEASE)
  payout(@Body() dto: PayoutDto, @Req() req: any) {
    return this.holdsSvc.payout(dto.technician_id, req.user.sub);
  }

  @Get('payouts') @RequirePermissions(P.PAYMENT_VIEW)
  payouts() {
    return this.ds.query(
      `SELECT id, technician_id, amount::bigint/100.0 AS amount, state, reference, created_at
         FROM payouts ORDER BY id DESC LIMIT 50`);
  }

  /** Everything owed but not yet paid — the finance work queue. */
  @Get('payables') @RequirePermissions(P.PAYMENT_VIEW)
  payables() {
    return this.ds.query(
      `SELECT a.owner_id AS technician_id,
              ROUND((COALESCE(SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE 0 END),0)
                   - COALESCE(SUM(CASE WHEN e.direction='debit'  THEN e.amount ELSE 0 END),0))/100.0, 2) AS owed
         FROM accounts a JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.code = 'technician_payable'
        GROUP BY a.owner_id HAVING (COALESCE(SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE 0 END),0)
                                  - COALESCE(SUM(CASE WHEN e.direction='debit' THEN e.amount ELSE 0 END),0)) > 0
        ORDER BY owed DESC`);
  }

  @Get('holds') @RequirePermissions(P.PAYMENT_VIEW)
  holds() {
    return this.ds.query(
      `SELECT id, work_order_id, hirer_id, technician_id,
              amount::bigint/100.0 AS amount, state, created_at
         FROM holds ORDER BY id DESC LIMIT 100`);
  }

  @Get('balance/me') @RequirePermissions(P.PAYMENT_VIEW)
  async myBalance(@Req() req: any) {
    const ownerType = req.user.subject_type === 'technician' ? 'technician' : 'hirer';
    const ownerId = ownerType === 'hirer' ? req.user.sub : req.user.subject_id;
    const rows = await this.ds.query(
      `SELECT a.code,
              ROUND((COALESCE(SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE 0 END),0)
                   - COALESCE(SUM(CASE WHEN e.direction='debit'  THEN e.amount ELSE 0 END),0))/100.0, 2) AS balance
         FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id
        WHERE a.owner_type=$1 AND a.owner_id=$2 GROUP BY a.code`, [ownerType, ownerId]);
    return { owner_type: ownerType, owner_id: ownerId, accounts: rows };
  }
}
