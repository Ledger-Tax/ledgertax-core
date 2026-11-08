# Changelog

All notable changes to `@veronicdev/ledgertax-core` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is 0.x, a minor version may change the public API.

## [Unreleased]

## [0.1.1] - 2026-11-08

Documentation only; the code is the same as 0.1.0.

### Changed

- README: install section and current status. The README shown on npmjs.com for 0.1.0 said the package was not published yet.

## [0.1.0] - 2026-11-07

First published version.

### Added

- `parseStellarAddress` and `isLikelySecretKey`: validate a public address (G... or muxed M...) and reject anything shaped like a secret key without echoing it.
- `classifyTransaction`: turns the records of one Horizon transaction into typed events (payments, path payments, trades including maker-side fills, fees, account creation and merges, claimable-balance claims). Anything else becomes an `unknown` event with its raw reference.
- `classifyAccount`: streams events for an address from a `HistorySource`, one transaction at a time; `StreamInterruptedError` carries the cursor to resume from.
- `HorizonSource`: reads history from a Horizon server you configure, merges the transaction list with the account's effects, retries 429 and 5xx responses with back-off, and reports the available range with `coverage()`.
- `FixtureSource`: replays recorded records from disk.
- Typed errors: `LedgerTaxError`, `InvalidAddressError`, `SecretKeyInputError`, `MalformedRecordError`, `AccountNotFoundError`, `HorizonHttpError`, `HorizonResponseError`, `StreamInterruptedError`, `FixtureFormatError`, `FixtureNotFoundError`, `InvalidCursorError`.
- ESM and CommonJS builds with type declarations.

[Unreleased]: https://github.com/Ledger-Tax/ledgertax-core/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Ledger-Tax/ledgertax-core/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Ledger-Tax/ledgertax-core/releases/tag/v0.1.0
