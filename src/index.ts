/** Package name, used by the smoke test to prove the build and test pipeline works. */
export const PACKAGE_NAME = 'ledgertax-core' as const;

export { isLikelySecretKey, parseStellarAddress } from './address.js';
export type { ParsedAddress } from './address.js';
export { StreamInterruptedError, classifyAccount } from './classify-account.js';
export type { ClassifyAccountOptions } from './classify-account.js';
export {
  AccountNotFoundError,
  HorizonHttpError,
  HorizonResponseError,
  HorizonSource,
} from './horizon-source.js';
export type { HorizonCoverage, HorizonSourceOptions } from './horizon-source.js';
export { classifyTransaction } from './classify/index.js';
export type { ClassifyContext } from './classify/index.js';
export {
  InvalidAddressError,
  LedgerTaxError,
  MalformedRecordError,
  SecretKeyInputError,
} from './errors.js';
export {
  FixtureFormatError,
  FixtureNotFoundError,
  FixtureSource,
  InvalidCursorError,
} from './fixture-source.js';
export type { Result } from './result.js';
export { rawRecordSchema } from './types.js';
export type {
  AssetId,
  EventType,
  FetchOptions,
  HistorySource,
  Label,
  LedgerEvent,
  RawRecord,
} from './types.js';
