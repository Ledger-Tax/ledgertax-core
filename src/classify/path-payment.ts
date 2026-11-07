import { z } from 'zod';
import {
  amountSchema,
  assetFromFields,
  makeEvent,
  moved,
  opBaseSchema,
  parseData,
  toStroops,
} from './common.js';
import type { OpView, TxView } from './common.js';
import type { LedgerEvent } from '../types.js';

const pathPaymentSchema = opBaseSchema.extend({
  from: z.string().min(1),
  to: z.string().min(1),
  /** Amount of the destination asset actually delivered. */
  amount: amountSchema,
});

/**
 * `path_payment_strict_send` and `path_payment_strict_receive`.
 *
 * The conversion the sender's account went through is a `trade` effect and is classified by
 * {@link classifyTradeEffect}, so this function only emits the movement of the delivered asset:
 *  - the watched address is the sender and the receiver is someone else: `payment_out` of the
 *    delivered asset (after the trade leg converted the sent asset into it);
 *  - the watched address is the receiver and the sender is someone else: `payment_in`;
 *  - a path payment to oneself moves nothing beyond its trade legs, so no payment event.
 */
export function classifyPathPayment(view: TxView, op: OpView): LedgerEvent[] {
  const d = parseData(pathPaymentSchema, op.record);
  const asset = assetFromFields(op.record, 'asset');
  const amount = toStroops(d.amount, op.record.ref, 'amount');
  if (d.from === d.to) return [];
  if (d.from === view.address) {
    return [
      makeEvent(view, op.record, op.opIndex, 0, 'payment_out', moved(view, asset, amount, d.to)),
    ];
  }
  if (d.to === view.address) {
    return [
      makeEvent(view, op.record, op.opIndex, 0, 'payment_in', moved(view, asset, amount, d.from)),
    ];
  }
  return [];
}
