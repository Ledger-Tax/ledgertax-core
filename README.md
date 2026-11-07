# ledgertax-core

TypeScript library that classifies the public Stellar history of an address into typed events (payments, trades, fees, merges and so on).

**Accounting export, not tax advice.** Tax rules differ by country, and classification can be wrong. Events the library does not understand are returned as `unknown`, never hidden.

**Status:** early. Read-only: it never holds keys, signs or sends anything. It is not published to npm yet.

## What works today

- `parseStellarAddress(input)` validates a public address (G... or muxed M...) and returns a typed result. `isLikelySecretKey(input)` flags anything shaped like a secret key. A secret-shaped input is rejected and never echoed.
- `classifyTransaction(records, { address })` turns the records of one Horizon transaction into events.
- `classifyAccount(source, address, opts)` streams events from a `HistorySource`, one transaction at a time, and reports a resume cursor if the source fails part-way.
- `HorizonSource` reads history from a Horizon server you configure (base URL required, no default). It merges the account's transaction list with its effects so maker-side fills are not missed, retries 429/5xx with back-off, resumes from a cursor, and `coverage()` reports how far back the server's history goes. Tested against a fake Horizon built from recorded data, and checked once against live testnet.
- `FixtureSource` replays recorded records from disk (used by the tests).
- Real testnet fixtures, and the script that records them, in `test/fixtures/` and `scripts/record-fixtures.ts`.

See [docs/CLASSIFICATION.md](docs/CLASSIFICATION.md) for exactly what each event type means and what is **not** classified, and [docs/FIXTURES.md](docs/FIXTURES.md) for how the fixtures were made.

## What does not exist yet

- Only one network source exists (Horizon). The public SDF Horizon keeps about one year of history, so older cost basis is missing; report that range via `coverage()`.
- Liquidity pools, Soroban contract events, several linked addresses, mainnet use end to end: not implemented.

## Usage

```ts
import { HorizonSource, classifyAccount } from 'ledgertax-core';

const source = new HorizonSource({ baseUrl: process.env.HORIZON_URL ?? '' }); // or FixtureSource / your own
try {
  for await (const event of classifyAccount(source, address)) {
    console.log(event.type, event.asset, event.amount); // amount is a bigint in stroops
  }
} catch (error) {
  // StreamInterruptedError carries `cursor`: pass it as { cursor } to resume.
}
```

ESM and CommonJS builds are both produced, and a test imports both.

## Develop

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm fixtures:record` creates throwaway **testnet** accounts in memory and records new fixtures. It refuses to run against anything but testnet. It prints and stores no secret keys.
