import { z } from 'zod';
import {
  CLASSIC_DECIMALS,
  amountSchema,
  effectOpId,
  makeEvent,
  moved,
  opBaseSchema,
  parseData,
  toStroops,
} from './common.js';
import type { OpView, TxView } from './common.js';
import type { LedgerEvent } from '../types.js';

const createAccountSchema = opBaseSchema.extend({
  funder: z.string().min(1),
  account: z.string().min(1),
  starting_balance: amountSchema,
});

/**
 * `create_account`: the new account gets `account_funded`; the funder (if watched) gets a
 * native `payment_out` to the new account.
 */
export function classifyCreateAccount(view: TxView, op: OpView): LedgerEvent[] {
  const d = parseData(createAccountSchema, op.record);
  const amount = toStroops(d.starting_balance, op.record.ref, 'starting_balance');
  if (d.account === view.address) {
    return [
      makeEvent(
        view,
        op.record,
        op.opIndex,
        0,
        'account_funded',
        moved(view, 'native', amount, d.funder),
      ),
    ];
  }
  if (d.funder === view.address) {
    return [
      makeEvent(
        view,
        op.record,
        op.opIndex,
        0,
        'payment_out',
        moved(view, 'native', amount, d.account),
      ),
    ];
  }
  return [];
}

const mergeSchema = opBaseSchema.extend({
  account: z.string().min(1),
  into: z.string().min(1),
});

/**
 * `account_merge`: the merged account (`direction: out`) and the destination (`direction: in`)
 * each get an `account_merged` event. The amount is not in the operation record; it comes from
 * the account's `account_debited` / `account_credited` effect of the same operation. If that
 * effect is absent the event is still emitted, without an amount.
 */
export function classifyMerge(view: TxView, op: OpView): LedgerEvent[] {
  const d = parseData(mergeSchema, op.record);
  const mergedAway = d.account === view.address;
  const receiving = d.into === view.address;
  if (!mergedAway && !receiving) return [];

  const wanted = mergedAway ? 'account_debited' : 'account_credited';
  const effect = view.effects.find(
    (e) =>
      effectOpId(String(e.data['id'])) === op.id &&
      e.data['type'] === wanted &&
      e.data['account'] === view.address &&
      e.data['asset_type'] === 'native' &&
      typeof e.data['amount'] === 'string',
  );
  const amount =
    effect && typeof effect.data['amount'] === 'string'
      ? toStroops(effect.data['amount'], effect.ref, 'amount')
      : undefined;
  const counterparty = mergedAway ? d.into : d.account;
  return [
    makeEvent(view, op.record, op.opIndex, 0, 'account_merged', {
      direction: mergedAway ? 'out' : 'in',
      counterparty,
      ...(amount !== undefined ? { asset: 'native', amount, decimals: CLASSIC_DECIMALS } : {}),
    }),
  ];
}
