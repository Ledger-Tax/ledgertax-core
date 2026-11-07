import { describe, expect, it } from 'vitest';
import { InvalidAddressError, MalformedRecordError, classifyTransaction } from '../src/index.js';
import type { LedgerEvent, RawRecord } from '../src/index.js';
import { B, ISSUER, M, TEST_ASSET, W, clone, groupWithOp, loadGroups } from './helpers.js';

const STROOPS = 10_000_000n;

function classify(group: RawRecord[], address = W): LedgerEvent[] {
  return classifyTransaction(group, { address });
}
function byType(events: LedgerEvent[], type: string): LedgerEvent[] {
  return events.filter((e) => e.type === type);
}

/** The transaction in which W itself submitted the manage_buy_offer that filled B's offer. */
function takerOfferGroup(): RawRecord[] {
  const g = loadGroups(W).find((group) =>
    group.some(
      (r) =>
        r.kind === 'operation' &&
        r.data['type'] === 'manage_buy_offer' &&
        r.data['source_account'] === W,
    ),
  );
  if (!g) throw new Error('fixture has no taker offer');
  return g;
}

describe('payments', () => {
  it('classifies a payment out, with the memo carried as untrusted text', () => {
    const events = classify(groupWithOp(W, 'payment', 0));
    const out = byType(events, 'payment_out');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      address: W,
      asset: 'native',
      amount: 100n * STROOPS,
      decimals: 7,
      counterparty: B,
      memo: '=1+1 test',
      opIndex: 0,
    });
    expect(byType(events, 'fee')).toHaveLength(1);
  });

  it('classifies a payment in, and an issued-asset payment', () => {
    const all = loadGroups(W).flatMap((g) => classify(g));
    const inbound = byType(all, 'payment_in');
    expect(
      inbound.some(
        (e) => e.asset === 'native' && e.counterparty === B && e.amount === 50n * STROOPS,
      ),
    ).toBe(true);
    expect(
      inbound.some(
        (e) => e.asset === TEST_ASSET && e.counterparty === ISSUER && e.amount === 1000n * STROOPS,
      ),
    ).toBe(true);
  });

  it('emits nothing for a payment between two other addresses', () => {
    const group = clone(groupWithOp(W, 'payment', 0));
    const op = group.find((r) => r.kind === 'operation');
    if (!op) throw new Error('no op');
    op.data['from'] = B;
    op.data['to'] = ISSUER;
    expect(classify(group).filter((e) => e.type.startsWith('payment'))).toEqual([]);
  });

  it('emits both legs for a self-payment', () => {
    const group = clone(groupWithOp(W, 'payment', 0));
    const op = group.find((r) => r.kind === 'operation');
    if (!op) throw new Error('no op');
    op.data['to'] = W;
    const events = classify(group);
    expect(byType(events, 'payment_out')).toHaveLength(1);
    expect(byType(events, 'payment_in')).toHaveLength(1);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it('throws a typed error when the amount is missing or malformed', () => {
    for (const bad of [undefined, 'abc', '1.123456789', '-5']) {
      const group = clone(groupWithOp(W, 'payment', 0));
      const op = group.find((r) => r.kind === 'operation');
      if (!op) throw new Error('no op');
      if (bad === undefined) delete op.data['amount'];
      else op.data['amount'] = bad;
      expect(() => classify(group)).toThrow(MalformedRecordError);
    }
  });
});

describe('create account and merge', () => {
  it('classifies the funding of the watched account', () => {
    const first = loadGroups(W)[0];
    if (!first) throw new Error('empty fixture');
    const funded = byType(classify(first), 'account_funded');
    expect(funded).toHaveLength(1);
    expect(funded[0]).toMatchObject({ asset: 'native', amount: 10_000n * STROOPS });
  });

  it('classifies the funder side of create_account as a native payment out', () => {
    const events = classify(groupWithOp(W, 'create_account', 1));
    const out = byType(events, 'payment_out');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ asset: 'native', amount: 20n * STROOPS, counterparty: M });
  });

  it('classifies a merge from both sides, with amounts from the effects', () => {
    const into = byType(classify(groupWithOp(W, 'account_merge')), 'account_merged');
    expect(into).toHaveLength(1);
    expect(into[0]).toMatchObject({ direction: 'in', counterparty: M, asset: 'native' });
    expect(into[0]?.amount).toBeGreaterThan(19n * STROOPS);

    const away = byType(classify(groupWithOp(M, 'account_merge'), M), 'account_merged');
    expect(away).toHaveLength(1);
    expect(away[0]).toMatchObject({ direction: 'out', counterparty: W });
    expect(away[0]?.amount).toBe(into[0]?.amount);
  });

  it('still emits the merge event, without an amount, if the effect is missing', () => {
    const group = groupWithOp(W, 'account_merge').filter((r) => r.kind !== 'effect');
    const merged = byType(classify(group), 'account_merged');
    expect(merged).toHaveLength(1);
    expect(merged[0]?.amount).toBeUndefined();
  });

  it('throws a typed error when create_account has no starting balance', () => {
    const group = clone(groupWithOp(W, 'create_account', 0));
    const op = group.find((r) => r.kind === 'operation');
    if (!op) throw new Error('no op');
    delete op.data['starting_balance'];
    expect(() => classify(group)).toThrow(MalformedRecordError);
  });
});

describe('path payments', () => {
  it('classifies the sender side: a trade leg plus a payment out of the delivered asset', () => {
    const events = classify(groupWithOp(W, 'path_payment_strict_send', 0));
    const trade = byType(events, 'trade');
    expect(trade).toHaveLength(1);
    expect(trade[0]).toMatchObject({
      asset: 'native',
      amount: 10n * STROOPS,
      counterAsset: TEST_ASSET,
      counterAmount: 10n * STROOPS,
      counterparty: ISSUER,
    });
    expect(byType(events, 'payment_out')[0]).toMatchObject({
      asset: TEST_ASSET,
      amount: 10n * STROOPS,
      counterparty: B,
    });
  });

  it('classifies strict receive the same way', () => {
    const events = classify(groupWithOp(W, 'path_payment_strict_receive'));
    expect(byType(events, 'trade')).toHaveLength(1);
    expect(byType(events, 'payment_out')[0]).toMatchObject({
      asset: TEST_ASSET,
      amount: 5n * STROOPS,
    });
  });

  it('classifies the receiver side as a payment in only', () => {
    const group = groupWithOp(W, 'path_payment_strict_send', 1);
    const events = classify(group);
    expect(byType(events, 'payment_in')[0]).toMatchObject({
      asset: TEST_ASSET,
      amount: 10n * STROOPS,
      counterparty: B,
    });
    expect(byType(events, 'trade')).toHaveLength(0);
  });

  it('throws a typed error when the destination is missing', () => {
    const group = clone(groupWithOp(W, 'path_payment_strict_send', 0));
    const op = group.find((r) => r.kind === 'operation');
    if (!op) throw new Error('no op');
    delete op.data['to'];
    expect(() => classify(group)).toThrow(MalformedRecordError);
  });
});

describe('offers', () => {
  it('classifies a taker fill from the trade effect', () => {
    const events = classify(takerOfferGroup());
    const trades = byType(events, 'trade');
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      asset: 'native',
      amount: 30n * STROOPS,
      counterAsset: TEST_ASSET,
      counterAmount: 20n * STROOPS,
    });
    expect(byType(events, 'unknown')).toHaveLength(0);
  });

  it('classifies a maker-side fill that was submitted by someone else', () => {
    const makerFill = loadGroups(W).find((g) => {
      const tx = g.find((r) => r.kind === 'transaction');
      return (
        tx?.data['source_account'] !== W &&
        g.some((r) => r.kind === 'effect' && r.data['type'] === 'trade' && r.data['account'] === W)
      );
    });
    if (!makerFill) throw new Error('fixture has no maker-side fill');
    const trades = byType(classify(makerFill), 'trade');
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      asset: TEST_ASSET,
      amount: 40n * STROOPS,
      counterAsset: 'native',
      counterAmount: 80n * STROOPS,
      counterparty: B,
    });
    expect(byType(classify(makerFill), 'fee')).toHaveLength(0);
  });

  it('emits nothing for an offer that was only placed, apart from the fee', () => {
    const placed = groupWithOp(W, 'manage_sell_offer', 0);
    const events = classify(placed);
    expect(events.map((e) => e.type)).toEqual(['fee']);
  });

  it('throws a typed error for a trade effect with a missing amount', () => {
    const group = clone(takerOfferGroup());
    const effect = group.find(
      (r) => r.kind === 'effect' && r.data['type'] === 'trade' && r.data['account'] === W,
    );
    if (!effect) throw new Error('no trade effect');
    delete effect.data['sold_amount'];
    expect(() => classify(group)).toThrow(MalformedRecordError);
  });
});

describe('claimable balances', () => {
  it('classifies a claim with asset and amount from the effect', () => {
    const claimed = byType(
      classify(groupWithOp(W, 'claim_claimable_balance', 0)),
      'claimable_claimed',
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ asset: 'native', decimals: 7 });
    expect(claimed[0]?.amount).toBeGreaterThan(0n);
  });

  it('emits no claim event when someone else claims', () => {
    const group = clone(groupWithOp(W, 'claim_claimable_balance', 0));
    const op = group.find((r) => r.kind === 'operation');
    if (!op) throw new Error('no op');
    op.data['claimant'] = B;
    expect(byType(classify(group), 'claimable_claimed')).toHaveLength(0);
  });

  it('turns creating a claimable balance into unknown (not classified in the MVP)', () => {
    const events = classify(groupWithOp(W, 'create_claimable_balance', 0));
    expect(byType(events, 'unknown')[0]).toMatchObject({ opType: 'create_claimable_balance' });
  });

  it('throws a typed error when the claimant is missing', () => {
    const group = clone(groupWithOp(W, 'claim_claimable_balance', 0));
    const op = group.find((r) => r.kind === 'operation');
    if (!op) throw new Error('no op');
    delete op.data['claimant'];
    expect(() => classify(group)).toThrow(MalformedRecordError);
  });
});

describe('fees', () => {
  it('charges the fee to the source account of a normal transaction', () => {
    const fee = byType(classify(groupWithOp(W, 'payment', 0)), 'fee');
    expect(fee).toEqual([
      expect.objectContaining({ asset: 'native', amount: 100n, decimals: 7, opIndex: -1 }),
    ]);
  });

  it('charges a fee-bump fee to the fee payer, not the inner source', () => {
    const bump = loadGroups(W).find((g) =>
      g.some((r) => r.kind === 'transaction' && r.data['fee_bump_transaction'] !== undefined),
    );
    if (!bump) throw new Error('fixture has no fee bump');
    expect(byType(classify(bump), 'fee')).toHaveLength(0);
    const payerEvents = classify(bump, B);
    expect(byType(payerEvents, 'fee')[0]).toMatchObject({ amount: 200n });
  });

  it('yields only the fee for an operation inside a failed transaction', () => {
    const failed = loadGroups(W).find((g) =>
      g.some((r) => r.kind === 'transaction' && r.data['successful'] === false),
    );
    if (!failed) throw new Error('fixture has no failed transaction');
    const events = classify(failed);
    expect(events.map((e) => e.type)).toEqual(['fee']);
  });
});

describe('unknown', () => {
  it('turns unsupported operations into unknown events with their type and raw reference', () => {
    for (const type of ['change_trust', 'set_options', 'liquidity_pool_deposit']) {
      const group = groupWithOp(W, type, 0);
      const op = group.find((r) => r.kind === 'operation' && r.data['type'] === type);
      const unknown = byType(classify(group), 'unknown');
      expect(unknown, type).toHaveLength(1);
      expect(unknown[0]).toMatchObject({ opType: type, raw: { ref: op?.ref } });
      expect(unknown[0]?.amount).toBeUndefined();
    }
  });

  it('keeps an operation type that was invented after this code was written', () => {
    const group = clone(groupWithOp(W, 'set_options', 0));
    const op = group.find((r) => r.kind === 'operation');
    if (!op) throw new Error('no op');
    op.data['type'] = 'some_future_operation';
    expect(byType(classify(group), 'unknown')[0]).toMatchObject({
      opType: 'some_future_operation',
    });
  });

  it('turns a liquidity pool trade effect into unknown', () => {
    const group = clone(takerOfferGroup());
    const effect = group.find(
      (r) => r.kind === 'effect' && r.data['type'] === 'trade' && r.data['account'] === W,
    );
    if (!effect) throw new Error('no trade effect');
    effect.data['type'] = 'liquidity_pool_trade';
    const events = classify(group);
    expect(byType(events, 'trade')).toHaveLength(0);
    expect(byType(events, 'unknown')[0]).toMatchObject({ opType: 'liquidity_pool_trade' });
  });
});

describe('robustness', () => {
  it('is idempotent: duplicate records give the same events and unique ids', () => {
    const group = groupWithOp(W, 'path_payment_strict_send', 0);
    const once = classify(group);
    const twice = classify([...group, ...group]);
    expect(twice).toEqual(once);
    expect(new Set(once.map((e) => e.id)).size).toBe(once.length);
  });

  it('gives every event of the whole fixture a unique, stable id', () => {
    const events = loadGroups(W).flatMap((g) => classify(g));
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    expect(
      loadGroups(W)
        .flatMap((g) => classify(g))
        .map((e) => e.id),
    ).toEqual(events.map((e) => e.id));
  });

  it('never drops a recorded operation: each op is classified, intentionally empty, or unknown', () => {
    const events = loadGroups(W).flatMap((g) => classify(g));
    expect(byType(events, 'unknown').length).toBeGreaterThan(0);
    for (const e of events) expect(e.raw.ref).toBeTruthy();
  });

  it('throws a typed error when a transaction record is missing', () => {
    const group = groupWithOp(W, 'payment', 0).filter((r) => r.kind !== 'transaction');
    expect(() => classify(group)).toThrow(MalformedRecordError);
  });

  it('throws a typed error when an operation does not belong to the transaction', () => {
    const group = clone(groupWithOp(W, 'payment', 0));
    const op = group.find((r) => r.kind === 'operation');
    if (!op) throw new Error('no op');
    op.data['transaction_hash'] = 'f'.repeat(64);
    expect(() => classify(group)).toThrow(MalformedRecordError);
  });

  it('throws a typed error for a transaction missing fee fields', () => {
    const group = clone(groupWithOp(W, 'payment', 0));
    const tx = group.find((r) => r.kind === 'transaction');
    if (!tx) throw new Error('no tx');
    delete tx.data['fee_charged'];
    expect(() => classify(group)).toThrow(MalformedRecordError);
  });

  it('rejects an invalid watched address', () => {
    expect(() => classifyTransaction(groupWithOp(W, 'payment', 0), { address: 'nope' })).toThrow(
      InvalidAddressError,
    );
  });
});

describe('reconciliation', () => {
  it('rebuilds the real account balances from the events (live testnet values recorded 2026-11-06)', () => {
    const net = new Map<string, bigint>();
    const add = (asset: string, v: bigint) => net.set(asset, (net.get(asset) ?? 0n) + v);
    for (const g of loadGroups(W)) {
      for (const e of classify(g)) {
        const a = e.asset ?? '';
        const n = e.amount ?? 0n;
        if (['payment_in', 'account_funded', 'claimable_claimed'].includes(e.type)) add(a, n);
        if (['payment_out', 'fee'].includes(e.type)) add(a, -n);
        if (e.type === 'account_merged') add(a, e.direction === 'in' ? n : -n);
        if (e.type === 'trade') {
          add(a, -n);
          add(e.counterAsset ?? '', e.counterAmount ?? 0n);
        }
      }
    }
    // Two operations are `unknown` in the MVP and carry no amount, so their effect is added by hand:
    add('native', -10n * STROOPS); // liquidity pool deposit: 10 XLM
    add(TEST_ASSET, -10n * STROOPS); // liquidity pool deposit: 10 TEST
    add('native', -5n * STROOPS); // create_claimable_balance for B: 5 XLM
    // Balances read from Horizon testnet after the recording run.
    expect(Object.fromEntries(net)).toEqual({
      native: 99_759_998_600n,
      [TEST_ASSET]: 9_800_000_000n,
    });
  });
});
