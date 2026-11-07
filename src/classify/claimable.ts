import { z } from 'zod';
import {
  CLASSIC_DECIMALS,
  amountSchema,
  assetFromString,
  effectOpId,
  makeEvent,
  opBaseSchema,
  parseData,
  toStroops,
} from './common.js';
import type { OpView, TxView } from './common.js';
import type { LedgerEvent } from '../types.js';

const claimSchema = opBaseSchema.extend({
  claimant: z.string().min(1),
});

const claimedEffectSchema = z.looseObject({
  asset: z.string().min(1),
  amount: amountSchema,
});

/**
 * `claim_claimable_balance`: if the watched address is the claimant it gets a
 * `claimable_claimed` event. Asset and amount are not in the operation record; they come from the
 * `claimable_balance_claimed` effect of the same operation (the event is still emitted, without
 * an amount, if that effect is absent). A claim by someone else produces no event. Creating a
 * claimable balance is not classified in the MVP and becomes `unknown`.
 */
export function classifyClaim(view: TxView, op: OpView): LedgerEvent[] {
  const d = parseData(claimSchema, op.record);
  if (d.claimant !== view.address) return [];
  const effect = view.effects.find(
    (e) =>
      effectOpId(String(e.data['id'])) === op.id &&
      e.data['type'] === 'claimable_balance_claimed' &&
      e.data['account'] === view.address,
  );
  if (!effect) return [makeEvent(view, op.record, op.opIndex, 0, 'claimable_claimed')];
  const c = parseData(claimedEffectSchema, effect);
  return [
    makeEvent(view, op.record, op.opIndex, 0, 'claimable_claimed', {
      asset: assetFromString(c.asset, effect.ref, 'asset'),
      amount: toStroops(c.amount, effect.ref, 'amount'),
      decimals: CLASSIC_DECIMALS,
      ...(view.memo !== undefined ? { memo: view.memo } : {}),
    }),
  ];
}
