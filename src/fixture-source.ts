import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseStellarAddress } from './address.js';
import { InvalidAddressError, LedgerTaxError, SecretKeyInputError } from './errors.js';
import { rawRecordSchema } from './types.js';
import type { FetchOptions, HistorySource, RawRecord } from './types.js';

/** No fixture file exists for the requested address. */
export class FixtureNotFoundError extends LedgerTaxError {
  constructor() {
    super('fixture_not_found', 'No fixture file for this address.');
  }
}

/** A fixture file exists but is not a valid list of records. */
export class FixtureFormatError extends LedgerTaxError {
  constructor(detail: string) {
    super('fixture_format', `Fixture file is malformed: ${detail}`);
  }
}

/** The resume cursor does not match any record. */
export class InvalidCursorError extends LedgerTaxError {
  constructor() {
    super('invalid_cursor', 'The cursor does not match any record in this source.');
  }
}

const fixtureFileSchema = z.array(rawRecordSchema);

/**
 * A {@link HistorySource} that replays recorded records from `<dir>/<address>.json`.
 * Used by tests; it never touches the network.
 */
export class FixtureSource implements HistorySource {
  readonly name = 'fixture';

  /** @param dir - folder holding one JSON file per address */
  constructor(private readonly dir: string) {}

  /**
   * Yields the recorded records for an address, oldest first, in file order.
   *
   * @throws InvalidAddressError / SecretKeyInputError if the address is not a public key
   * @throws FixtureNotFoundError / FixtureFormatError / InvalidCursorError
   */
  async *fetch(address: string, opts: FetchOptions = {}): AsyncIterable<RawRecord> {
    const parsed = parseStellarAddress(address);
    if (!parsed.ok) {
      throw parsed.error instanceof SecretKeyInputError
        ? new SecretKeyInputError()
        : new InvalidAddressError();
    }

    const records = await this.load(parsed.value.address);

    let start = 0;
    if (opts.cursor !== undefined) {
      const at = records.findIndex((r) => r.cursor === opts.cursor);
      if (at < 0) throw new InvalidCursorError();
      start = at + 1;
    }

    const sinceMs = opts.since === undefined ? undefined : Date.parse(opts.since);
    let yielded = 0;
    for (const record of records.slice(start)) {
      if (opts.limit !== undefined && yielded >= opts.limit) return;
      if (sinceMs !== undefined && record.time !== undefined && Date.parse(record.time) < sinceMs) {
        continue;
      }
      yielded += 1;
      yield record;
    }
  }

  private async load(address: string): Promise<RawRecord[]> {
    let text: string;
    try {
      text = await readFile(join(this.dir, `${address}.json`), 'utf8');
    } catch {
      throw new FixtureNotFoundError();
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new FixtureFormatError('not valid JSON');
    }
    const result = fixtureFileSchema.safeParse(json);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new FixtureFormatError(
        issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid',
      );
    }
    return result.data;
  }
}
