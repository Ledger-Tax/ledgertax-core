import { makeEvent, mentions } from './common.js';
import type { OpView, TxView } from './common.js';
import type { LedgerEvent, RawRecord } from '../types.js';

/**
 * Anything the classifier does not understand becomes an `unknown` event carrying its raw
 * reference and operation type. It is never dropped and never guessed.
 *
 * An operation is only reported if it concerns the watched address: the address is its source
 * account, or appears anywhere in the record (for example as a claimant or a clawback target).
 *
 * WAVE-ISSUE(core-1): liquidity pool deposit / withdraw operations land here until classified.
 * WAVE-ISSUE(core-2): `invoke_host_function` (Soroban) operations land here until classified.
 */
export function classifyUnknownOperation(view: TxView, op: OpView): LedgerEvent[] {
  const concerns = op.data['source_account'] === view.address || mentions(op.data, view.address);
  if (!concerns) return [];
  return [makeEvent(view, op.record, op.opIndex, 0, 'unknown', { opType: op.type })];
}

/**
 * A liquidity pool trade effect for the watched address (a path payment or offer that crossed a
 * pool). Not classified in the MVP: reported as `unknown`.
 *
 * WAVE-ISSUE(core-1): classify pool trades, deposits and withdrawals together.
 */
export function classifyPoolTradeEffect(
  view: TxView,
  effect: RawRecord,
  opIndex: number,
): LedgerEvent[] {
  if (effect.data['account'] !== view.address) return [];
  const idx = /^\d+-(\d+)$/.exec(String(effect.data['id']))?.[1] ?? effect.ref;
  return [
    makeEvent(view, effect, opIndex, `e${idx.replace(/^0+(?=\d)/, '')}`, 'unknown', {
      opType: 'liquidity_pool_trade',
    }),
  ];
}
