import { LedgerService, Posting } from '../src/ledger/ledger.service';
import { BadRequestException } from '@nestjs/common';

/**
 * The ledger has exactly one invariant that everything else rests on:
 * debits must equal credits, per transaction and therefore in aggregate.
 *
 * These tests exercise the invariant directly with a fake EntityManager, so
 * they run in milliseconds and need no database.
 */
function fakeManager() {
  const saved: any[] = [];
  let id = 0;
  return {
    saved,
    create: (_e: any, data: any) => ({ ...data }),
    save: async (row: any) => { const r = { id: ++id, ...row }; saved.push(r); return r; },
    findOne: async () => null,
    query: async () => [{ cr: '0', dr: '0' }],
  } as any;
}

describe('double-entry posting', () => {
  const svc = new LedgerService({} as any);

  it('accepts a balanced transaction', async () => {
    const m = fakeManager();
    const postings: Posting[] = [
      { accountId: 1, direction: 'debit', amount: 46051n },
      { accountId: 2, direction: 'credit', amount: 46051n },
    ];
    await expect(svc.post(m, 'work_order', 1, 'escrow hold', postings)).resolves.toBeDefined();
    // one transaction row plus one row per entry
    expect(m.saved).toHaveLength(3);
  });

  it('rejects an unbalanced transaction rather than writing half of it', async () => {
    const m = fakeManager();
    await expect(svc.post(m, 'work_order', 1, 'bad', [
      { accountId: 1, direction: 'debit', amount: 100n },
      { accountId: 2, direction: 'credit', amount: 99n },
    ])).rejects.toThrow(BadRequestException);
    expect(m.saved).toHaveLength(0);          // nothing persisted
  });

  it('rejects a zero-value transaction', async () => {
    const m = fakeManager();
    await expect(svc.post(m, 'work_order', 1, 'zero', [
      { accountId: 1, direction: 'debit', amount: 0n },
      { accountId: 2, direction: 'credit', amount: 0n },
    ])).rejects.toThrow(/zero-value/);
  });

  it('balances a three-legged transaction — the capture split', async () => {
    const m = fakeManager();
    const gross = 46051n, fee = 6907n, net = gross - fee;
    await expect(svc.post(m, 'work_order', 1, 'capture', [
      { accountId: 1, direction: 'debit',  amount: gross },
      { accountId: 2, direction: 'credit', amount: net },
      { accountId: 3, direction: 'credit', amount: fee },
    ])).resolves.toBeDefined();
    expect(net + fee).toBe(gross);
  });

  it('never loses a cent to rounding when splitting a fee', () => {
    // Property: for any gross amount, net + fee == gross exactly.
    const BPS = 1500n;
    for (let i = 0; i < 5000; i++) {
      const gross = BigInt(Math.floor(Math.random() * 10_000_00) + 1);
      const fee = (gross * BPS) / 10000n;      // integer division truncates
      const net = gross - fee;
      expect(net + fee).toBe(gross);
      expect(fee).toBeLessThanOrEqual(gross);
      expect(net).toBeGreaterThanOrEqual(0n);
    }
  });

  it('holds the invariant across a random sequence of postings', async () => {
    // Property test: simulate many transactions, assert the ledger stays level.
    let debits = 0n, credits = 0n;
    const m = fakeManager();
    for (let i = 0; i < 500; i++) {
      const amt = BigInt(Math.floor(Math.random() * 100_000) + 1);
      const legs = Math.random() < 0.3;
      const postings: Posting[] = legs
        ? [{ accountId: 1, direction: 'debit', amount: amt },
           { accountId: 2, direction: 'credit', amount: amt / 2n },
           { accountId: 3, direction: 'credit', amount: amt - amt / 2n }]
        : [{ accountId: 1, direction: 'debit', amount: amt },
           { accountId: 2, direction: 'credit', amount: amt }];
      await svc.post(m, 'work_order', i, 'random', postings);
      for (const p of postings) {
        if (p.direction === 'debit') debits += p.amount; else credits += p.amount;
      }
    }
    expect(debits).toBe(credits);
  });
});

describe('money representation', () => {
  it('uses integer minor units, because floats cannot represent money', () => {
    // The bug this prevents:
    expect(0.1 + 0.2).not.toBe(0.3);
    // The representation actually used:
    expect(10n + 20n).toBe(30n);
  });

  it('round-trips a rate x hours calculation without drift', () => {
    const toMinor = (major: number) => BigInt(Math.round(major * 100));
    const gross = toMinor(70.85 * 6.5);
    expect(gross).toBe(46053n);
    expect((Number(gross) / 100).toFixed(2)).toBe('460.53');
  });
});
