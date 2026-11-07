# Classification

Accounting export, not tax advice. Classification describes what moved on the ledger. It does not say whether anything is taxable, and it can be wrong.

This document describes what `classifyTransaction` and `classifyAccount` do today, for Horizon-shaped records (see `docs/FIXTURES.md` for the record format). Everything here is covered by tests in `test/`.

## How records become events

- One transaction at a time: the transaction record, its operation records and its effect records (effects are tied to operations by id).
- Every event belongs to the **watched address**. Records about other accounts produce nothing for it.
- Amounts are `bigint` in the smallest unit; every classic asset and XLM has 7 decimals (`decimals: 7`). Assets are `native` or `CODE:ISSUER`.
- Event ids are `<txHash>:<opIndex>:<leg>`. They are stable, so classifying the same records again, or a duplicate record, gives the same ids.
- Memos are copied onto events as **untrusted text**. They are never interpreted.

## Event types

| Event type          | Produced by                                                                                                                                                                                  | Notes                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `payment_out`       | `payment` sent from the address; `path_payment_*` sent from the address to someone else (the delivered asset); `create_account` where the address is the funder (native, to the new account) | A payment out is not a sale. Meaning comes from a user label.                                                                          |
| `payment_in`        | `payment` received; `path_payment_*` received from someone else                                                                                                                              | A payment in is not income.                                                                                                            |
| `trade`             | a `trade` effect of the address: offer fills (as taker **and** as maker, including fills inside someone else's transaction) and the conversion step of path payments                         | `asset`/`amount` is what the address gave up, `counterAsset`/`counterAmount` what it got. An offer that is only placed gives no event. |
| `fee`               | the transaction's `fee_account`, for the fee charged (also when the transaction failed)                                                                                                      | `opIndex` is `-1`. In a fee-bump transaction the fee payer owns the fee, not the inner source.                                         |
| `account_funded`    | `create_account` where the address is the new account                                                                                                                                        | native starting balance                                                                                                                |
| `account_merged`    | `account_merge` where the address is the merged account (`direction: out`) or the destination (`direction: in`)                                                                              | The amount comes from the account's debit/credit effect; if that effect is missing the event has no amount.                            |
| `claimable_claimed` | `claim_claimable_balance` where the address is the claimant                                                                                                                                  | Asset and amount come from the `claimable_balance_claimed` effect; without it the event has no amount.                                 |
| `unknown`           | every other operation that concerns the address (it is the source account, or appears anywhere in the record); and `liquidity_pool_trade` effects                                            | Carries `opType` and `raw.ref`. Never dropped, never guessed.                                                                          |

## Rules worth knowing

- **Failed transactions** produce only the `fee` event.
- **A self-payment** produces one `payment_out` and one `payment_in` (they cancel).
- **A path payment** to someone else is two events: a `trade` (sent asset to delivered asset) and a `payment_out` of the delivered asset. A path payment to the address itself is only its trade legs.
- **Missing or malformed fields** throw a `MalformedRecordError` naming the record. Nothing is guessed.
- **An operation nobody can attribute to the address** (for example a payment between two other accounts that happens to share a transaction) produces nothing.

## What is NOT classified (becomes `unknown`, or nothing)

- `create_claimable_balance`: the funds the address locks up leave its balance but the event has no amount. The recorded fixture reconciles to the real balance only after adding this by hand (see `test/classify.test.ts`, "reconciliation").
- Liquidity pool deposit and withdraw, and pool trades (WAVE-ISSUE core-1).
- Soroban `invoke_host_function` and contract events (WAVE-ISSUE core-2).
- `change_trust`, `set_options`, sponsorship operations, clawback and any operation type not listed above: reported as `unknown` when they concern the address. XLM reserves locked by trustlines, offers and sponsorship are not tracked as movements.
- Multiple linked addresses: an own-wallet transfer shows as a payment out of one address and a payment in of another (WAVE-ISSUE core-3).
- A path payment whose conversion went only through a liquidity pool: by design the delivered-asset `payment_out` is emitted but the pool trade is `unknown`, so the asset balance would not add up (read from the code; no fixture covers it).

## Source requirement

`classifyAccount` needs the source to deliver records grouped by transaction, transaction record first. Horizon's per-account transaction list alone is **not enough**: it omits maker-side fills (see `docs/FIXTURES.md`). `HorizonSource` does this (it merges both lists); any other adapter must too.
