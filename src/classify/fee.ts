import { CLASSIC_DECIMALS, makeEvent } from './common.js';
import type { TxView } from './common.js';
import type { LedgerEvent, RawRecord } from '../types.js';

/**
 * Fee event: the network fee is charged to the transaction's `fee_account` (the source account,
 * or the fee-bump payer). It is emitted even when the transaction failed.
 * The fee event has `opIndex` -1 because it belongs to the transaction, not an operation.
 */
export function classifyFee(view: TxView, txRecord: RawRecord): LedgerEvent[] {
  if (view.feeAccount !== view.address) return [];
  return [
    makeEvent(view, txRecord, -1, 0, 'fee', {
      asset: 'native',
      amount: view.feeCharged,
      decimals: CLASSIC_DECIMALS,
    }),
  ];
}
