import { z } from 'zod';
import { parseStellarAddress } from './address.js';
import { LedgerTaxError } from './errors.js';
import type { FetchOptions, HistorySource, RawRecord } from './types.js';

/** The account does not exist on this network (never funded). It has no history. */
export class AccountNotFoundError extends LedgerTaxError {
  constructor() {
    super('account_not_found', 'This account does not exist on the network, so it has no history.');
  }
}

/** Horizon answered with an HTTP error, or could not be reached, even after retries. */
export class HorizonHttpError extends LedgerTaxError {
  /** HTTP status, or 0 for a network failure or timeout. */
  readonly status: number;
  /** Delay the server asked for with Retry-After, in ms. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, detail: string, retryAfterMs?: number) {
    super(
      'horizon_http',
      `Horizon request failed (${status === 0 ? 'network' : status}): ${detail}`,
    );
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Horizon answered, but not with the shape this library expects. */
export class HorizonResponseError extends LedgerTaxError {
  constructor(detail: string) {
    super('horizon_response', `Unexpected Horizon response: ${detail}`);
  }
}

/** Options for {@link HorizonSource}. */
export interface HorizonSourceOptions {
  /** Horizon base URL, from configuration (for example the mainnet or testnet Horizon). */
  baseUrl: string;
  /** Replacement for `fetch`, for tests. */
  fetch?: typeof fetch;
  /** Records per request, 1..200. Default 200. */
  pageSize?: number;
  /** Retries for 429, 5xx and network errors. Default 3. */
  maxRetries?: number;
  /** Base delay for the retry back-off, in ms. Default 500. */
  retryDelayMs?: number;
  /** Replacement for the retry sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
}

/** What a Horizon server says about itself and how far back its history goes. */
export interface HorizonCoverage {
  baseUrl: string;
  networkPassphrase: string;
  horizonVersion: string;
  /** Oldest ledger the server still has. Anything older is missing from every report. */
  historyElderLedger: number;
  historyLatestLedger: number;
}

const rootSchema = z.looseObject({
  network_passphrase: z.string().min(1),
  horizon_version: z.string().min(1),
  history_elder_ledger: z.number().int(),
  history_latest_ledger: z.number().int(),
});

const pageSchema = z.looseObject({
  _embedded: z.looseObject({ records: z.array(z.record(z.string(), z.unknown())) }),
});

const txSchema = z.looseObject({
  hash: z.string().min(1),
  paging_token: z.string().regex(/^\d+$/),
  ledger: z.number().int().nonnegative(),
  created_at: z.string().min(1),
});

const TX_OP_MASK = 0xfffn;

type Json = Record<string, unknown>;

/**
 * A {@link HistorySource} backed by a Horizon server.
 *
 * Horizon's `/accounts/{id}/transactions` omits transactions in which someone else's order filled
 * this account's resting offer (maker-side fills), although `/accounts/{id}/effects` contains
 * them. This source therefore merges the two lists, so no trade is silently missed. For each
 * transaction it yields the transaction record, then its operations, then (if it succeeded) its
 * effects, oldest first: the grouping `classifyAccount` expects.
 *
 * Only the history the server still holds is returned (the public SDF Horizon keeps about a year).
 * Use {@link HorizonSource.coverage} to say which range a report covers.
 *
 * WAVE-ISSUE(core-5): a second adapter (for example a full-history provider) implements the same
 * interface.
 */
export class HorizonSource implements HistorySource {
  readonly name = 'horizon';
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly pageSize: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  /** @throws LedgerTaxError if the base URL is not a valid http(s) URL */
  constructor(options: HorizonSourceOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new LedgerTaxError('invalid_config', 'Horizon base URL is not a valid URL.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new LedgerTaxError('invalid_config', 'Horizon base URL must be http or https.');
    }
    if (url.username || url.password) {
      throw new LedgerTaxError('invalid_config', 'Horizon base URL must not contain credentials.');
    }
    this.baseUrl = url.toString().replace(/\/+$/, '');
    this.doFetch = options.fetch ?? fetch;
    this.pageSize = Math.min(200, Math.max(1, options.pageSize ?? 200));
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Reads the server's network passphrase, version and how far back its history goes. */
  async coverage(): Promise<HorizonCoverage> {
    const root = this.parse(rootSchema, await this.getJson('/'));
    return {
      baseUrl: this.baseUrl,
      networkPassphrase: root.network_passphrase,
      horizonVersion: root.horizon_version,
      historyElderLedger: root.history_elder_ledger,
      historyLatestLedger: root.history_latest_ledger,
    };
  }

  /**
   * Streams the records of one address, oldest first, grouped by transaction.
   *
   * @throws AccountNotFoundError, HorizonHttpError, HorizonResponseError
   */
  async *fetch(address: string, opts: FetchOptions = {}): AsyncIterable<RawRecord> {
    const parsed = parseStellarAddress(address);
    if (!parsed.ok) throw parsed.error;
    const account = parsed.value.address;

    const after = opts.cursor === undefined ? undefined : txPagingFromCursor(opts.cursor);
    const sinceMs = opts.since === undefined ? undefined : Date.parse(opts.since);

    const listed = this.listedTransactions(account, after)[Symbol.asyncIterator]();
    const viaEffects = this.effectTransactions(account, after)[Symbol.asyncIterator]();
    let yielded = 0;
    try {
      let a = await listed.next();
      let b = await viaEffects.next();
      while (!a.done || !b.done) {
        const pa = a.done ? undefined : BigInt(String(a.value['paging_token']));
        const pb = b.done ? undefined : b.value.paging;
        let tx: Json;
        if (pa !== undefined && (pb === undefined || pa <= pb)) {
          tx = a.value as Json;
          if (pa === pb) b = await viaEffects.next();
          a = await listed.next();
        } else if (b.done) {
          break;
        } else {
          tx = await this.transactionOfOperation(b.value.opId);
          b = await viaEffects.next();
        }
        const parsedTx = this.parse(txSchema, tx);
        if (sinceMs !== undefined && Date.parse(parsedTx.created_at) < sinceMs) continue;
        for await (const record of this.transactionRecords(tx, parsedTx.hash, parsedTx.ledger)) {
          if (opts.limit !== undefined && yielded >= opts.limit) return;
          yielded += 1;
          yield record;
        }
      }
    } finally {
      await listed.return?.(undefined);
      await viaEffects.return?.(undefined);
    }
  }

  /** The account's own transaction list (includes failed transactions). */
  private async *listedTransactions(account: string, after?: string): AsyncGenerator<Json> {
    yield* this.collection(
      `/accounts/${account}/transactions`,
      { include_failed: 'true' },
      after,
      true,
    );
  }

  /** Distinct transactions found through the account's effects, in order. */
  private async *effectTransactions(
    account: string,
    after?: string,
  ): AsyncGenerator<{ paging: bigint; opId: string }> {
    // Effects of every operation of transaction T have ids up to T | 0xfff.
    const cursor = after === undefined ? undefined : `${BigInt(after) | TX_OP_MASK}-99999999`;
    let last: bigint | undefined;
    for await (const effect of this.collection(`/accounts/${account}/effects`, {}, cursor, true)) {
      const opId = /^(\d+)-\d+$/.exec(String(effect['paging_token']))?.[1];
      if (opId === undefined) throw new HorizonResponseError('effect without a paging token');
      const paging = BigInt(opId) & ~TX_OP_MASK;
      if (paging === last) continue;
      last = paging;
      yield { paging, opId };
    }
  }

  private async transactionOfOperation(opId: string): Promise<Json> {
    const op = await this.getJson(`/operations/${opId}`);
    const hash = op['transaction_hash'];
    if (typeof hash !== 'string' || hash.length === 0) {
      throw new HorizonResponseError('operation without a transaction hash');
    }
    return this.getJson(`/transactions/${hash}`);
  }

  private async *transactionRecords(
    tx: Json,
    hash: string,
    ledger: number,
  ): AsyncGenerator<RawRecord> {
    const time = String(tx['created_at']);
    yield toRecord('transaction', tx, ledger, time);
    for await (const op of this.collection(`/transactions/${hash}/operations`, {
      include_failed: 'true',
    })) {
      yield toRecord('operation', op, ledger, time);
    }
    if (tx['successful'] === true) {
      for await (const effect of this.collection(`/transactions/${hash}/effects`, {})) {
        yield toRecord('effect', effect, ledger, time);
      }
    }
  }

  /** Walks every page of a Horizon collection, oldest first. */
  private async *collection(
    path: string,
    extra: Record<string, string>,
    startCursor?: string,
    tolerateMissing = false,
  ): AsyncGenerator<Json> {
    let cursor = startCursor;
    for (;;) {
      const query = new URLSearchParams({ order: 'asc', limit: String(this.pageSize), ...extra });
      if (cursor !== undefined) query.set('cursor', cursor);
      let page: Json;
      try {
        page = await this.getJson(`${path}?${query.toString()}`);
      } catch (error) {
        if (error instanceof HorizonHttpError && error.status === 404 && tolerateMissing) {
          throw new AccountNotFoundError();
        }
        throw error;
      }
      const records = this.parse(pageSchema, page)._embedded.records;
      for (const record of records) yield record;
      const last = records[records.length - 1];
      if (records.length < this.pageSize || last === undefined) return;
      cursor = String(last['paging_token']);
    }
  }

  private parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
    const result = schema.safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new HorizonResponseError(
        `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`,
      );
    }
    return result.data;
  }

  /** GET with retries on 429, 5xx and network errors. */
  private async getJson(pathAndQuery: string): Promise<Json> {
    let lastError: HorizonHttpError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const delay = lastError?.retryAfterMs ?? this.retryDelayMs * 2 ** (attempt - 1);
        await this.sleep(Math.min(delay, 30_000));
      }
      let response: Response;
      try {
        response = await this.doFetch(`${this.baseUrl}${pathAndQuery}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = new HorizonHttpError(0, error instanceof Error ? error.name : 'unknown');
        continue;
      }
      if (response.ok) {
        try {
          return (await response.json()) as Json;
        } catch {
          throw new HorizonResponseError('body is not JSON');
        }
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      lastError = new HorizonHttpError(
        response.status,
        response.statusText || 'error',
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
      if (response.status !== 429 && response.status < 500) throw lastError;
    }
    throw lastError ?? new HorizonHttpError(0, 'no attempt made');
  }
}

function toRecord(kind: RawRecord['kind'], source: Json, ledger: number, time: string): RawRecord {
  const data = { ...source };
  delete data['_links'];
  const token = String(source['paging_token']);
  return {
    source: 'horizon',
    ref: String(source['id']),
    cursor: `${kind}:${token}`,
    kind,
    time: typeof source['created_at'] === 'string' ? source['created_at'] : time,
    ledger,
    data,
  };
}

/** Transaction paging token a record cursor (`<kind>:<paging token>`) belongs to. */
function txPagingFromCursor(cursor: string): string {
  const m = /^(?:transaction|operation|effect|trade):(\d+)(?:-\d+)?$/.exec(cursor);
  if (!m?.[1])
    throw new LedgerTaxError('invalid_cursor', 'The cursor is not a Horizon source cursor.');
  return (BigInt(m[1]) & ~TX_OP_MASK).toString();
}
