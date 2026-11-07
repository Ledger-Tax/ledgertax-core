import { z } from 'zod';
import { parseStellarAddress } from '../address.js';
import { MalformedRecordError } from '../errors.js';
import type { LedgerEvent, RawRecord } from '../types.js';
import { classifyCreateAccount, classifyMerge } from './account.js';
import { classifyClaim } from './claimable.js';
import { effectOpId, opBaseSchema, parseData } from './common.js';
import type { OpView, TxView } from './common.js';
import { classifyFee } from './fee.js';
import { classifyPathPayment } from './path-payment.js';
import { classifyPayment } from './payment.js';
import { classifyTradeEffect } from './trade.js';
import { classifyPoolTradeEffect, classifyUnknownOperation } from './unknown.js';

/** Context for classification. */
export interface ClassifyContext {
  /** The watched public address (G...). WAVE-ISSUE(core-3): several linked addresses plug in here. */
  address: string;
}

const txSchema = z.looseObject({
  hash: z.string().min(1),
  paging_token: z.string().regex(/^\d+$/),
  successful: z.boolean(),
  operation_count: z.number().int().nonnegative(),
  fee_account: z.string().min(1),
  fee_charged: z.string().regex(/^\d+$/),
  memo: z.string().optional(),
});

/** Operations whose events come entirely from `trade` effects (fills), not from the operation. */
const OFFER_OPERATIONS = new Set([
  'manage_sell_offer',
  'manage_buy_offer',
  'create_passive_sell_offer',
]);

/**
 * Classifies the records of ONE transaction into events for the watched address.
 *
 * `records` must hold the transaction record, its operation records and its effect records, in
 * any order. Duplicate records (same cursor) are ignored, so repeated input gives the same
 * events with the same ids. Rules:
 *  - the fee is a separate `fee` event, owned by the transaction's fee account;
 *  - a failed transaction yields only its fee event;
 *  - payments, create account, merge, path payments, trades (including offer fills) and claims
 *    are classified; anything else becomes `unknown`;
 *  - a record with a missing or malformed field throws a {@link MalformedRecordError}.
 *
 * @param records - the transaction's source records
 * @param ctx - the watched address
 * @returns events in a stable order: fee first, then per operation
 * @throws InvalidAddressError / SecretKeyInputError for a bad address, MalformedRecordError for bad records
 */
export function classifyTransaction(
  records: readonly RawRecord[],
  ctx: ClassifyContext,
): LedgerEvent[] {
  const parsed = parseStellarAddress(ctx.address);
  if (!parsed.ok) throw parsed.error;
  const address = parsed.value.address;

  const seen = new Set<string>();
  const unique = records.filter((r) => (seen.has(r.cursor) ? false : (seen.add(r.cursor), true)));

  const txRecords = unique.filter((r) => r.kind === 'transaction');
  const txRecord = txRecords[0];
  if (!txRecord) {
    throw new MalformedRecordError(
      unique[0]?.ref ?? '(none)',
      'no transaction record in the group',
    );
  }
  if (txRecords.length > 1) {
    throw new MalformedRecordError(
      txRecords[1]?.ref ?? '(none)',
      'more than one transaction record',
    );
  }
  const tx = parseData(txSchema, txRecord);
  if (txRecord.ledger === undefined || txRecord.time === undefined) {
    throw new MalformedRecordError(txRecord.ref, 'ledger and time are required');
  }

  const view: TxView = {
    address,
    txHash: tx.hash,
    txPaging: BigInt(tx.paging_token),
    operationCount: tx.operation_count,
    ledger: txRecord.ledger,
    time: txRecord.time,
    feeAccount: tx.fee_account,
    feeCharged: BigInt(tx.fee_charged),
    ...(tx.memo !== undefined ? { memo: tx.memo } : {}),
    effects: unique.filter((r) => r.kind === 'effect'),
  };

  const events: LedgerEvent[] = classifyFee(view, txRecord);
  if (!tx.successful) return events;

  const ops = unique
    .filter((r) => r.kind === 'operation')
    .map((record): OpView => {
      const d = parseData(opBaseSchema, record);
      const opIndex = Number(BigInt(d.id) - view.txPaging - 1n);
      if (opIndex < 0 || opIndex >= view.operationCount || d.transaction_hash !== view.txHash) {
        throw new MalformedRecordError(record.ref, 'operation does not belong to this transaction');
      }
      return { record, data: record.data, id: d.id, type: d.type, opIndex };
    })
    .sort((a, b) => a.opIndex - b.opIndex);

  for (const op of ops) {
    events.push(...classifyOperation(view, op));
    for (const effect of view.effects) {
      if (effectOpId(String(effect.data['id'])) !== op.id) continue;
      if (effect.data['type'] === 'trade')
        events.push(...classifyTradeEffect(view, effect, op.opIndex));
      if (effect.data['type'] === 'liquidity_pool_trade') {
        events.push(...classifyPoolTradeEffect(view, effect, op.opIndex));
      }
    }
  }
  return events;
}

function classifyOperation(view: TxView, op: OpView): LedgerEvent[] {
  switch (op.type) {
    case 'payment':
      return classifyPayment(view, op);
    case 'create_account':
      return classifyCreateAccount(view, op);
    case 'account_merge':
      return classifyMerge(view, op);
    case 'path_payment_strict_send':
    case 'path_payment_strict_receive':
      return classifyPathPayment(view, op);
    case 'claim_claimable_balance':
      return classifyClaim(view, op);
    default:
      // Offers produce events only through their fills (trade effects).
      return OFFER_OPERATIONS.has(op.type) ? [] : classifyUnknownOperation(view, op);
  }
}
