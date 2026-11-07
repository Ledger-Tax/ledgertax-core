import { z } from 'zod';
import { MalformedRecordError } from '../errors.js';
import type { AssetId, EventType, LedgerEvent, RawRecord } from '../types.js';

/** Classic Stellar assets (and XLM) have 7 decimal places: amounts are stroops. */
export const CLASSIC_DECIMALS = 7;

/** Parsed view of one transaction, shared by every family classifier. */
export interface TxView {
  /** The watched address. */
  address: string;
  txHash: string;
  /** Horizon paging token of the transaction; operation ids are derived from it. */
  txPaging: bigint;
  operationCount: number;
  ledger: number;
  time: string;
  feeAccount: string;
  feeCharged: bigint;
  memo?: string;
  /** Effect records of this transaction. */
  effects: RawRecord[];
}

/** An operation record that passed the common-field check. */
export interface OpView {
  record: RawRecord;
  data: Record<string, unknown>;
  id: string;
  type: string;
  opIndex: number;
}

const digits = z.string().regex(/^\d+$/);
const nonEmpty = z.string().min(1);

/** Fields every Horizon operation record has. */
export const opBaseSchema = z.looseObject({
  id: digits,
  type: nonEmpty,
  transaction_hash: nonEmpty,
  transaction_successful: z.boolean(),
  source_account: nonEmpty,
});

/** A decimal amount as Horizon prints it: digits with up to 7 decimals. */
export const amountSchema = z.string().regex(/^\d+(\.\d{1,7})?$/);

/**
 * Parses a validated schema, turning a failure into a {@link MalformedRecordError}.
 *
 * @param schema - zod schema for the record's data
 * @param record - the raw record being read
 */
export function parseData<S extends z.ZodType>(schema: S, record: RawRecord): z.output<S> {
  const result = schema.safeParse(record.data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'record';
    throw new MalformedRecordError(record.ref, `${where}: ${issue?.message ?? 'invalid'}`);
  }
  return result.data;
}

/**
 * Converts a Horizon decimal string ("12.5000000") into smallest units (stroops) as a bigint.
 *
 * @throws MalformedRecordError if the text is not a plain decimal with up to 7 places
 */
export function toStroops(text: string, ref: string, field: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(text);
  if (!m) throw new MalformedRecordError(ref, `${field} is not a valid amount`);
  return BigInt(m[1] ?? '0') * 10_000_000n + BigInt((m[2] ?? '').padEnd(CLASSIC_DECIMALS, '0'));
}

const ASSET_ID = /^(native|[A-Za-z0-9]{1,12}:G[A-Z2-7]{55})$/;

/**
 * Reads an asset from Horizon's split fields (`<prefix>_type`, `<prefix>_code`, `<prefix>_issuer`).
 *
 * @param prefix - for example `asset`, `sold_asset`, `bought_asset`
 * @returns `"native"` or `"CODE:ISSUER"`
 */
export function assetFromFields(record: RawRecord, prefix: string): AssetId {
  const d = record.data;
  const type = d[`${prefix}_type`];
  if (type === 'native') return 'native';
  const code = d[`${prefix}_code`];
  const issuer = d[`${prefix}_issuer`];
  if (
    (type === 'credit_alphanum4' || type === 'credit_alphanum12') &&
    typeof code === 'string' &&
    typeof issuer === 'string'
  ) {
    const id = `${code}:${issuer}`;
    if (ASSET_ID.test(id)) return id;
  }
  throw new MalformedRecordError(record.ref, `${prefix} is missing or not a valid asset`);
}

/** Validates an asset already given as a single string (`native` or `CODE:ISSUER`). */
export function assetFromString(value: string, ref: string, field: string): AssetId {
  if (!ASSET_ID.test(value)) throw new MalformedRecordError(ref, `${field} is not a valid asset`);
  return value;
}

/** Numeric operation id an effect belongs to: effect ids look like `0024019441394126849-0000000001`. */
export function effectOpId(effectId: string): string | undefined {
  const m = /^(\d+)-\d+$/.exec(effectId);
  return m?.[1]?.replace(/^0+(?=\d)/, '');
}

/** Effect index (the part after the dash) of an effect id. */
export function effectIndex(effectId: string): string | undefined {
  return /^\d+-(\d+)$/.exec(effectId)?.[1]?.replace(/^0+(?=\d)/, '');
}

/** True if any string value anywhere in `value` equals `address`. */
export function mentions(value: unknown, address: string): boolean {
  if (typeof value === 'string') return value === address;
  if (Array.isArray(value)) return value.some((v) => mentions(v, address));
  if (value && typeof value === 'object') {
    return Object.values(value).some((v) => mentions(v, address));
  }
  return false;
}

/**
 * Builds an event with the fields every event shares.
 *
 * @param leg - distinguishes several events from one operation (`0`, `1`, or `e<effect index>`)
 */
export function makeEvent(
  view: TxView,
  record: RawRecord,
  opIndex: number,
  leg: string | number,
  type: EventType,
  extra: Partial<LedgerEvent> = {},
): LedgerEvent {
  return {
    id: `${view.txHash}:${opIndex}:${leg}`,
    txHash: view.txHash,
    opIndex,
    ledger: view.ledger,
    time: view.time,
    type,
    address: view.address,
    raw: { source: record.source, ref: record.ref },
    ...extra,
  };
}

/** Extra fields for an event that moves `amount` of a classic asset. */
export function moved(
  view: TxView,
  asset: AssetId,
  amount: bigint,
  counterparty?: string,
): Partial<LedgerEvent> {
  return {
    asset,
    amount,
    decimals: CLASSIC_DECIMALS,
    ...(counterparty !== undefined ? { counterparty } : {}),
    ...(view.memo !== undefined ? { memo: view.memo } : {}),
  };
}
