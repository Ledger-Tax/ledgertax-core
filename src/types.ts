import { z } from 'zod';

/**
 * Asset identifier: `"native"`, `"CODE:ISSUER"` for classic assets, or a `C...` contract id.
 * (Final form is a Gate 1 decision; see docs/RESEARCH.md.)
 */
export type AssetId = string;

/** Every kind of event the classifier can produce. */
export type EventType =
  | 'payment_in'
  | 'payment_out'
  | 'trade'
  | 'fee'
  | 'account_funded'
  | 'account_merged'
  | 'claimable_claimed'
  | 'unknown';

/**
 * A classified event. Amounts are `bigint` in the asset's smallest unit with `decimals`
 * stored beside them; times are UTC ISO strings plus the ledger sequence.
 */
export interface LedgerEvent {
  /** Stable id: `${txHash}:${opIndex}:${leg}`. */
  id: string;
  txHash: string;
  opIndex: number;
  ledger: number;
  /** UTC ISO timestamp. */
  time: string;
  type: EventType;
  /** The watched address this event belongs to. */
  address: string;
  asset?: AssetId;
  amount?: bigint;
  decimals?: number;
  counterAsset?: AssetId;
  counterAmount?: bigint;
  counterDecimals?: number;
  counterparty?: string;
  /** Untrusted text from the chain. */
  memo?: string;
  /** Source operation type (for example `change_trust`), set on `unknown` events and trades. */
  opType?: string;
  /** Set only where the event type does not already imply a direction (`account_merged`). */
  direction?: 'in' | 'out';
  /** Pointer back to the source record. */
  raw: { source: string; ref: string };
}

/** A user label that overlays an event. Labels never mutate events. */
export interface Label {
  eventId: string;
  label: 'income' | 'disposal' | 'transfer' | 'gift' | 'ignore';
  note?: string;
}

/** Schema for a record returned by a {@link HistorySource}. */
export const rawRecordSchema = z.object({
  /** Name of the source that produced the record. */
  source: z.string().min(1),
  /** Stable reference to the record inside that source (for example an operation id). */
  ref: z.string().min(1),
  /** Opaque paging cursor; resuming with it returns records after this one. */
  cursor: z.string().min(1),
  /** Which kind of source record this is. */
  kind: z.enum(['transaction', 'operation', 'effect', 'trade']),
  /** UTC ISO time of the ledger close, when known. */
  time: z.iso.datetime().optional(),
  /** Ledger sequence, when known. */
  ledger: z.number().int().nonnegative().optional(),
  /** The source's own JSON for the record, shape-checked later by the classifiers. */
  data: z.record(z.string(), z.unknown()),
});

/** One record of raw history from a source. */
export type RawRecord = z.infer<typeof rawRecordSchema>;

/** Options for {@link HistorySource.fetch}. */
export interface FetchOptions {
  /** Resume after the record with this cursor. */
  cursor?: string;
  /** Maximum number of records to yield. */
  limit?: number;
  /** Only records at or after this UTC ISO time. */
  since?: string;
}

/** Where raw history comes from. WAVE-ISSUE(core-5): a second adapter plugs in here. */
export interface HistorySource {
  readonly name: string;
  /**
   * Streams records for one address, oldest first.
   *
   * @param address - a validated public address
   * @param opts - cursor, limit and start time
   */
  fetch(address: string, opts?: FetchOptions): AsyncIterable<RawRecord>;
}
