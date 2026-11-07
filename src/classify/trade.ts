import { z } from 'zod';
import {
  CLASSIC_DECIMALS,
  amountSchema,
  assetFromFields,
  effectIndex,
  makeEvent,
  parseData,
  toStroops,
} from './common.js';
import type { TxView } from './common.js';
import type { LedgerEvent, RawRecord } from '../types.js';

const tradeEffectSchema = z.looseObject({
  id: z.string().min(1),
  type: z.literal('trade'),
  account: z.string().min(1),
  seller: z.string().min(1).optional(),
  sold_amount: amountSchema,
  bought_amount: amountSchema,
});

/**
 * A `trade` effect of the watched address becomes a `trade` event.
 *
 * Offers (`manage_sell_offer`, `manage_buy_offer`, `create_passive_sell_offer`) and the conversion
 * step of path payments are all classified here, from the effects, because the operation records
 * only hold the offer parameters, not what was filled. This also catches maker-side fills: a
 * transaction submitted by someone else that filled the watched address's resting offer.
 *
 * In a trade effect `sold_*` and `bought_*` are from the point of view of the effect's `account`
 * (verified on testnet fixtures). An offer that was placed but not filled produces no event.
 *
 * @param opIndex - index of the operation inside the transaction
 */
export function classifyTradeEffect(
  view: TxView,
  effect: RawRecord,
  opIndex: number,
): LedgerEvent[] {
  const d = parseData(tradeEffectSchema, effect);
  if (d.account !== view.address) return [];
  const leg = `e${effectIndex(d.id) ?? effect.ref}`;
  return [
    makeEvent(view, effect, opIndex, leg, 'trade', {
      asset: assetFromFields(effect, 'sold_asset'),
      amount: toStroops(d.sold_amount, effect.ref, 'sold_amount'),
      decimals: CLASSIC_DECIMALS,
      counterAsset: assetFromFields(effect, 'bought_asset'),
      counterAmount: toStroops(d.bought_amount, effect.ref, 'bought_amount'),
      counterDecimals: CLASSIC_DECIMALS,
      ...(d.seller !== undefined && d.seller !== d.account ? { counterparty: d.seller } : {}),
      ...(view.memo !== undefined ? { memo: view.memo } : {}),
    }),
  ];
}
