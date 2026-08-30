import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Envelope, caused } from '@fn/tsevents';
import { LedgerService } from '../ledger/ledger.service';
import { Account, Hold, Payout } from '../ledger/entities';
import { OutboxMessage } from '../outbox/outbox.entity';

const PLATFORM_FEE_BPS = 1500;              // 15%, in basis points
const toMinor = (major: number) => BigInt(Math.round(major * 100));
const fmt = (minor: bigint) => (Number(minor) / 100).toFixed(2);

@Injectable()
export class HoldsService {
  private readonly log = new Logger('Holds');
  constructor(@InjectDataSource() private ds: DataSource, private ledger: LedgerService) {}

  /**
   * Reserve funds when a work order is dispatched.
   *
   * Nothing leaves the hirer — money moves from their available balance into
   * escrow. If they cannot cover it, we publish payment.failed rather than
   * throwing: an under-funded hirer is a business outcome the platform must
   * react to, not a system error to retry.
   */
  async placeHold(env: Envelope) {
    const { work_order_id, assignment_id, hirer_id, pay_rate, duration_hours, technician_id } = env.payload;
    const gross = toMinor(Number(pay_rate || 0) * Number(duration_hours || 1));

    await this.ds.transaction(async (m) => {
      // Keyed on the assignment, not the work order: a work order legitimately
      // gets several offers in sequence, and each needs its own reservation.
      const existing = await m.findOne(Hold, { where: { assignmentId: assignment_id } });
      if (existing) { this.log.log(`hold already exists for assignment ${assignment_id}`); return; }

      const funds  = await this.ledger.account(m, 'hirer_funds', 'hirer', hirer_id, 'liability');
      const escrow = await this.ledger.account(m, 'escrow', 'platform', null, 'liability');

      const available = await this.ledger.balance(m, funds.id);
      if (available < gross) {
        const out = caused(env, 'payment.failed', {
          work_order_id, assignment_id, hirer_id, amount: Number(fmt(gross)),
          reason: `insufficient funds: available ${fmt(available)}, required ${fmt(gross)}`,
        });
        await m.save(m.create(OutboxMessage, { eventType: out.type, envelope: out }));
        this.log.warn(`hold FAILED wo=${work_order_id} need ${fmt(gross)} have ${fmt(available)}`);
        return;
      }

      // Debit reduces a liability: the hirer's claim on us shrinks by the amount
      // now committed. Credit escrow: that same amount is now ring-fenced.
      await this.ledger.post(m, 'work_order', work_order_id,
        `escrow hold for work order ${work_order_id}`,
        [{ accountId: funds.id,  direction: 'debit',  amount: gross },
         { accountId: escrow.id, direction: 'credit', amount: gross }],
        env.correlation_id);

      const hold = await m.save(m.create(Hold, {
        workOrderId: work_order_id, assignmentId: assignment_id,
        hirerId: hirer_id, technicianId: technician_id,
        amount: gross.toString(), state: 'placed', correlationId: env.correlation_id }));

      const out = caused(env, 'payment.hold_placed', {
        work_order_id, assignment_id, hirer_id, amount: Number(fmt(gross)),
        currency: 'USD', hold_id: hold.id });
      await m.save(m.create(OutboxMessage, { eventType: out.type, envelope: out }));
      this.log.log(`hold PLACED wo=${work_order_id} ${fmt(gross)}`);
    });
  }

  /**
   * Discharge what a technician has earned.
   *
   * Guarded by payment:release, which only finance and admin hold -- a hirer
   * can approve work but cannot move money out, and a technician cannot pay
   * themselves. The balance is read inside the transaction so two concurrent
   * payout requests cannot both see the full amount.
   */
  async payout(technicianId: number, requestedBy: number) {
    return this.ds.transaction(async (m) => {
      const payable = await this.ledger.account(m, 'technician_payable', 'technician',
                                                technicianId, 'liability');
      const cash    = await this.ledger.account(m, 'cash', 'platform', null, 'asset');
      const owed = await this.ledger.balance(m, payable.id);
      if (owed <= 0n) return { paid: 0, message: 'nothing owed' };

      await this.ledger.post(m, 'payout', technicianId,
        `payout to technician ${technicianId}`,
        [{ accountId: payable.id, direction: 'debit',  amount: owed },
         { accountId: cash.id,    direction: 'credit', amount: owed }]);

      const p = await m.save(m.create(Payout, {
        technicianId, amount: owed.toString(), state: 'paid',
        reference: `PO-${Date.now().toString(36).toUpperCase()}`, requestedBy }));

      this.log.log(`PAYOUT technician=${technicianId} ${fmt(owed)} ref=${p.reference}`);
      return { paid: Number(fmt(owed)), reference: p.reference, payout_id: p.id };
    });
  }

  /** Technician accepted — the reservation becomes firm. */
  async confirmHold(env: Envelope) {
    const { assignment_id, work_order_id } = env.payload;
    await this.ds.query(
      `UPDATE holds SET state='confirmed' WHERE assignment_id=$1 AND state='placed'`,
      [assignment_id]);
    this.log.log(`hold CONFIRMED assignment=${assignment_id} wo=${work_order_id}`);
  }

  /** Rejected, expired or cancelled — reverse the reservation. */
  async releaseHold(env: Envelope) {
    const { work_order_id, assignment_id } = env.payload;
    await this.ds.transaction(async (m) => {
      // Release THIS assignment's hold. Because the lookup is by assignment,
      // a release arriving before or after another assignment's dispatch has
      // no effect on it -- the handlers commute.
      const hold = assignment_id
        ? await m.findOne(Hold, { where: { assignmentId: assignment_id } })
        : await m.findOne(Hold, { where: { workOrderId: work_order_id }, order: { id: 'DESC' } });

      // Already settled -- nothing to undo. Idempotent by design, because this
      // event can legitimately arrive more than once.
      if (hold && ['released', 'captured'].includes(hold.state)) return;

      // The hold does not exist YET.
      //
      // A technician can decline within milliseconds of being dispatched, and
      // those two events arrive on different queues, so the release can overtake
      // the placement. Returning quietly here strands the hold forever.
      //
      // Throwing hands the message to the retry ladder: it comes back in five
      // seconds, by which time the placement has almost certainly landed. This
      // is exactly what the ladder is for -- a transient ordering problem, not a
      // permanent failure. If it is still missing after all three tiers it lands
      // in the parking lot, which is the correct outcome for a release against a
      // hold that genuinely never existed.
      if (!hold) {
        throw new Error(
          `no hold yet for assignment ${assignment_id} (work order ${work_order_id}) — retrying`);
      }

      const funds  = await this.ledger.account(m, 'hirer_funds', 'hirer', hold.hirerId, 'liability');
      const escrow = await this.ledger.account(m, 'escrow', 'platform', null, 'liability');
      const amount = BigInt(hold.amount);

      await this.ledger.post(m, 'work_order', work_order_id,
        `release escrow for work order ${work_order_id}`,
        [{ accountId: escrow.id, direction: 'debit',  amount },
         { accountId: funds.id,  direction: 'credit', amount }],
        env.correlation_id);

      hold.state = 'released';
      await m.save(hold);

      const out = caused(env, 'payment.hold_released', {
        work_order_id, assignment_id: hold.assignmentId, hirer_id: hold.hirerId,
        amount: Number(fmt(amount)), hold_id: hold.id,
        reason: env.payload.reason ?? env.type });
      await m.save(m.create(OutboxMessage, { eventType: out.type, envelope: out }));
      this.log.log(`hold RELEASED assignment=${hold.assignmentId} wo=${work_order_id} ${fmt(amount)}`);
    });
  }

  /** Work approved — escrow splits into technician earnings and platform fee. */
  async capture(env: Envelope) {
    const { work_order_id } = env.payload;
    await this.ds.transaction(async (m) => {
      // Capture the confirmed hold for this work order -- the one the
      // technician actually accepted.
      const hold = await m.findOne(Hold, {
        where: { workOrderId: work_order_id, state: 'confirmed' }, order: { id: 'DESC' } });
      if (!hold) { this.log.warn(`no confirmed hold for wo ${work_order_id}`); return; }

      const escrow  = await this.ledger.account(m, 'escrow', 'platform', null, 'liability');
      const payable = await this.ledger.account(m, 'technician_payable', 'technician',
                                                hold.technicianId, 'liability');
      const revenue = await this.ledger.account(m, 'platform_revenue', 'platform', null, 'revenue');

      const gross = BigInt(hold.amount);
      const fee   = (gross * BigInt(PLATFORM_FEE_BPS)) / 10000n;
      const net   = gross - fee;

      await this.ledger.post(m, 'work_order', work_order_id,
        `capture for work order ${work_order_id}`,
        [{ accountId: escrow.id,  direction: 'debit',  amount: gross },
         { accountId: payable.id, direction: 'credit', amount: net },
         { accountId: revenue.id, direction: 'credit', amount: fee }],
        env.correlation_id);

      hold.state = 'captured';
      await m.save(hold);

      const out = caused(env, 'payment.captured', {
        work_order_id, hirer_id: hold.hirerId, technician_id: hold.technicianId,
        amount: Number(fmt(gross)), platform_fee: Number(fmt(fee)),
        net_to_technician: Number(fmt(net)) });
      await m.save(m.create(OutboxMessage, { eventType: out.type, envelope: out }));
      this.log.log(`CAPTURED wo=${work_order_id} gross=${fmt(gross)} fee=${fmt(fee)} net=${fmt(net)}`);
    });
  }
}
