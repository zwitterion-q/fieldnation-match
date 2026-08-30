/**
 * Funds hirer accounts so dispatches can actually reserve money.
 *
 * Deposits are posted as real double-entry transactions -- debit cash (an asset
 * we now hold), credit hirer_funds (a liability we owe them). One hirer is
 * funded deliberately low so the insufficient-funds path is demonstrable.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import { Account, LedgerEntry, LedgerTransaction, Hold } from '../ledger/entities';
import { OutboxMessage } from '../outbox/outbox.entity';
import { ProcessedMessage } from '../inbox/processed-message.entity';

const PAYMENTS_DSN = process.env.PAYMENTS_DSN || 'postgresql://fn:fn@localhost:55435/payments';
const IDENTITY_DSN = process.env.IDENTITY_DSN || 'postgresql://fn:fn@localhost:55434/identity';

async function main() {
  // synchronize is deliberately OFF here. The service owns its schema; a seeder
  // that also synchronises will happily DROP a column it does not know about
  // when its image is a build behind -- which is exactly what happened once.
  // This is the argument for migrations over synchronize in anything real.
  const ds = new DataSource({ type: 'postgres', url: PAYMENTS_DSN,
    entities: [Account, LedgerEntry, LedgerTransaction, Hold, OutboxMessage, ProcessedMessage],
    synchronize: false });
  await ds.initialize();

  const idc = new Client({ connectionString: IDENTITY_DSN }); await idc.connect();
  const hirers = (await idc.query(
    `SELECT id, email, company_name FROM users WHERE subject_type='hirer' ORDER BY id`)).rows;
  await idc.end();

  await ds.transaction(async (m) => {
    const cash = await m.save(m.create(Account,
      { code: 'cash', ownerType: 'platform', ownerId: null, kind: 'asset' }));

    for (const [i, h] of hirers.entries()) {
      // Last hirer gets $250 so the insufficient-funds branch is reachable.
      const major = i === hirers.length - 1 ? 250 : 25_000;
      const amount = BigInt(major * 100);

      const funds = await m.save(m.create(Account,
        { code: 'hirer_funds', ownerType: 'hirer', ownerId: h.id, kind: 'liability' }));

      const tx = await m.save(m.create(LedgerTransaction, {
        refType: 'deposit', refId: h.id,
        description: `opening deposit — ${h.company_name}` }));
      await m.save(m.create(LedgerEntry,
        { transactionId: tx.id, accountId: cash.id,  direction: 'debit',  amount: amount.toString() }));
      await m.save(m.create(LedgerEntry,
        { transactionId: tx.id, accountId: funds.id, direction: 'credit', amount: amount.toString() }));

      console.log(`  ${h.company_name ?? h.email}: $${major.toLocaleString()}`);
    }
  });

  const [tb] = await ds.query(
    `SELECT SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) AS diff FROM ledger_entries`);
  console.log(`\ntrial balance difference: ${tb.diff} (must be 0)`);
  await ds.destroy();
}
main().catch(e => { console.error(e); process.exit(1); });
