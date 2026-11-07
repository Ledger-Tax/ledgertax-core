# Fixtures

Accounting export, not tax advice.

The files in `test/fixtures/` are real Stellar **testnet** history recorded from throwaway accounts. They contain public addresses and Horizon responses only.

## How they were produced

```bash
pnpm fixtures:record      # optional: HORIZON_URL=<a testnet Horizon URL>
```

`scripts/record-fixtures.ts`:

1. Checks that the Horizon URL reports the testnet network passphrase and aborts otherwise. It cannot run against mainnet.
2. Generates four keypairs **in memory** (watched account `W`, counterparty `B`, issuer `I`, merging account `M`) and funds `W`, `B`, `I` with Friendbot. Secret keys are never printed, logged, written to disk or committed, and are discarded when the process exits.
3. Performs each operation once (see the list below) and prints only a step name and ok/FAILED.
4. Reads back the history of `W` and `M` from Horizon and writes `test/fixtures/<address>.json` plus `manifest.json` (public keys, step results, record counts).

Because the keypairs are discarded, the accounts cannot be reused. Re-running creates new accounts and new files; delete the old `G*.json` files and the manifest first. Testnet is reset from time to time, which does not affect the recorded files.

## Record format

Each file is an array of `RawRecord` (see `src/types.ts`), oldest first. For every transaction it holds the transaction record, then its operations, then its effects. `cursor` is `<kind>:<horizon paging token>`. The `_links` object of each Horizon record is removed, so an effect is tied to its operation through the id prefix (effect ids start with the operation id). The classifier relies on that link (the effect id, with leading zeros removed, equals the operation id); it holds for every recorded operation, and an operation's index inside its transaction is its id minus the transaction's paging token minus one.

## What is covered

| Case                                                                                        | Present                                      |
| ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| payment out (memo `=1+1 test`, formula-looking) and payment in (memo with comma and quotes) | yes                                          |
| create account, account merge (both sides)                                                  | yes                                          |
| change trust, issued-asset payment                                                          | yes                                          |
| manage sell offer / manage buy offer, as maker and as taker                                 | yes                                          |
| path payment strict send (out and in), strict receive                                       | yes                                          |
| claimable balance create and claim, both directions                                         | yes                                          |
| fee-bump transaction paid by another account (`fee_account` differs from `source_account`)  | yes                                          |
| failed transaction (`op_underfunded`, still charged a fee)                                  | yes                                          |
| set options (home domain), liquidity pool deposit                                           | yes (must become `unknown` in the MVP)       |
| invoke host function (Soroban)                                                              | **no**, out of MVP scope (WAVE-ISSUE core-2) |
| clawback, liquidity pool withdraw                                                           | **no**, not produced                         |

No record is synthetic. If a synthetic record is ever added, its file name must contain `synthetic`.

## Known limitation of the source

Horizon's `/accounts/{id}/transactions` does **not** list a transaction in which another account's order filled this account's resting offer (maker-side fill). The account's effects do contain it. The recorder merges both. Any real source adapter must do the same or it will silently miss trades. `test/fixtures.test.ts` asserts that such a fill is present.

## Privacy

Testnet accounts only. Never add the history of a real person's mainnet account as a fixture.
