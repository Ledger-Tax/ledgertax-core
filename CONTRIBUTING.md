# Contributing to ledgertax-core

Accounting export, not tax advice.

ledgertax-core is the TypeScript library that fetches Stellar history through a pluggable source and classifies operations into typed events. It is **read-only**: it never holds keys, signs or sends a transaction. Thank you for helping.

## Set up

You need Node.js 22.12 or newer and [pnpm](https://pnpm.io).

- `pnpm install --frozen-lockfile`

## Check your work

Run this before every pull request. It must pass:

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Rules that matter here

- **No secrets, ever.** Never put a secret key, seed phrase or API key in code, tests, logs, commits or issues. Use public addresses and testnet only; never target mainnet in tests.
- **No personal data.** Do not commit the history of a real person's account.
- **Do not guess.** Unknown things stay unknown; a missing price is an error row, not a guess. Documentation describes only what exists and is tested.
- **Money is not a float.** Use `bigint` or decimal strings.
- **Every public function** has JSDoc, one test for success and at least one for failure.
- **Ask before adding a dependency** (open an issue first). New dependencies must be justified.
- TypeScript is `strict`, with no `any`.
- Fixtures in `test/fixtures/` are **testnet** history recorded by `pnpm fixtures:record`, which creates throwaway accounts in memory. Never add the history of a real person's mainnet account.
- Read `docs/CLASSIFICATION.md` before changing what an event type means, and `docs/FIXTURES.md` before adding fixtures.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/) with `core` as the scope, for example `feat(core): add something` or `fix(core): handle an edge case`. Keep one logical change per commit.

## Claiming an issue

1. Pick an issue and comment that you would like to work on it. Wait for a maintainer to assign it to you.
2. Look for the marker named in the issue (for example `WAVE-ISSUE(...)`) in the code: it shows where your change plugs in.
3. Open a pull request that links the issue, states what you changed and shows the output of the check above.

Good first areas: a classifier for another operation family, another `HistorySource`, more fixtures, or documentation.

By contributing you agree that your contribution is licensed under the MIT license of this repository.
