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

const paymentSchema = opBaseSchema.extend({
  from: z.string().min(1),
  to: z.string().min(1),
  amount: amountSchema,
});

/**
 * `payment`: the watched address is the sender (`payment_out`), the receiver (`payment_in`), or
 * both (a self-payment emits one of each, which cancel out). A payment between two other
 * addresses produces no events.
 */
export function classifyPayment(view: TxView, op: OpView): LedgerEvent[] {
  const d = parseData(paymentSchema, op.record);
  const asset = assetFromFields(op.record, 'asset');
  const amount = toStroops(d.amount, op.record.ref, 'amount');
  const out: LedgerEvent[] = [];
  if (d.from === view.address) {
    out.push(
      makeEvent(view, op.record, op.opIndex, 0, 'payment_out', moved(view, asset, amount, d.to)),
    );
  }
  if (d.to === view.address) {
    out.push(
      makeEvent(view, op.record, op.opIndex, 1, 'payment_in', moved(view, asset, amount, d.from)),
    );
  }
  return out;
}
