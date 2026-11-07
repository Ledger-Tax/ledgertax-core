import { parseStellarAddress } from './address.js';
import { classifyTransaction } from './classify/index.js';
import { LedgerTaxError } from './errors.js';
import type { LedgerEvent, RawRecord, HistorySource } from './types.js';

/** Options for {@link classifyAccount}. */
export interface ClassifyAccountOptions {
  /** Resume after this cursor. Use only a cursor from {@link StreamInterruptedError.cursor}. */
  cursor?: string;
  /** Only history at or after this UTC ISO time. */
  since?: string;
}

/**
 * The history source failed part-way through. Events already yielded are complete; resume by
 * calling {@link classifyAccount} again with `{ cursor: error.cursor }`.
 */
export class StreamInterruptedError extends LedgerTaxError {
  /**
   * Cursor of the last record of the last fully classified transaction, or the cursor the run
   * started from if none was completed. Pass it back as `opts.cursor` to resume.
   */
  readonly cursor: string | undefined;
  override readonly cause: unknown;

  constructor(cursor: string | undefined, cause: unknown) {
    super(
      'stream_interrupted',
      `The history source failed: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
    this.cursor = cursor;
    this.cause = cause;
  }
}

/**
 * Streams the classified events of one address from a {@link HistorySource}.
 *
 * The source must deliver records grouped by transaction, the transaction record first
 * (the order the fixture recorder and a correct adapter produce). Only one transaction's
 * records are held in memory at a time, so history of any length can be processed.
 *
 * If the source throws, a {@link StreamInterruptedError} carries the cursor to resume from; the
 * transaction in progress is dropped and will be delivered again after resuming, so no event is
 * lost or repeated. A record the classifier cannot read throws a `MalformedRecordError`.
 *
 * WAVE-ISSUE(core-3): multiple linked addresses (own-wallet transfers are not trades) plug in here.
 *
 * @param source - where raw history comes from
 * @param address - the watched public address
 * @param opts - resume cursor and start time
 * @throws InvalidAddressError / SecretKeyInputError before any request is made
 */
export async function* classifyAccount(
  source: HistorySource,
  address: string,
  opts: ClassifyAccountOptions = {},
): AsyncGenerator<LedgerEvent, void, undefined> {
  const parsed = parseStellarAddress(address);
  if (!parsed.ok) throw parsed.error;
  const watched = parsed.value.address;

  let resumeFrom = opts.cursor;
  let group: RawRecord[] = [];

  const stream = source.fetch(watched, {
    ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
    ...(opts.since !== undefined ? { since: opts.since } : {}),
  });
  const iterator = stream[Symbol.asyncIterator]();

  try {
    for (;;) {
      let next: IteratorResult<RawRecord>;
      try {
        next = await iterator.next();
      } catch (error) {
        throw new StreamInterruptedError(resumeFrom, error);
      }
      if (next.done) break;

      const record = next.value;
      if (record.kind === 'transaction' && group.length > 0) {
        yield* classifyTransaction(group, { address: watched });
        resumeFrom = group[group.length - 1]?.cursor ?? resumeFrom;
        group = [];
      }
      group.push(record);
    }
    if (group.length > 0) yield* classifyTransaction(group, { address: watched });
  } finally {
    await iterator.return?.();
  }
}
