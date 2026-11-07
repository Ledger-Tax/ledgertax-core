import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  FixtureSource,
  InvalidAddressError,
  MalformedRecordError,
  SecretKeyInputError,
  StreamInterruptedError,
  classifyAccount,
  classifyTransaction,
} from '../src/index.js';
import type { LedgerEvent } from '../src/index.js';
import { FIXTURE_DIR, ListSource, W, loadGroups, loadRecords } from './helpers.js';

async function collect(gen: AsyncIterable<LedgerEvent>): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const expected = loadGroups(W).flatMap((g) => classifyTransaction(g, { address: W }));

describe('classifyAccount', () => {
  it('streams the whole fixture history from a FixtureSource', async () => {
    const events = await collect(classifyAccount(new FixtureSource(FIXTURE_DIR), W));
    expect(events.length).toBeGreaterThan(30);
    expect(events).toEqual(expected);
  });

  it('gives the same result however the source pages its records', async () => {
    // A source that serves 7 records at a time, so page edges fall inside transactions.
    const records = loadRecords(W);
    const paged = {
      name: 'paged',
      async *fetch(_a: string, opts: { cursor?: string } = {}) {
        let at =
          opts.cursor === undefined ? 0 : records.findIndex((r) => r.cursor === opts.cursor) + 1;
        while (at < records.length) {
          for (const r of records.slice(at, at + 7)) yield r;
          at += 7;
        }
      },
    };
    expect(await collect(classifyAccount(paged, W))).toEqual(expected);
  });

  it('streams: it does not read the whole history to produce the first event', async () => {
    const source = new ListSource(loadRecords(W));
    const gen = classifyAccount(source, W);
    const first = await gen.next();
    expect(first.done).toBe(false);
    const firstGroupSize = (loadGroups(W)[0] ?? []).length;
    // One group plus the record that starts the next group, never the whole history.
    expect(source.pulled).toBe(firstGroupSize + 1);
    expect(source.pulled).toBeLessThan(loadRecords(W).length / 4);
    await gen.return(undefined);
  });

  it('returns nothing for an empty account', async () => {
    expect(await collect(classifyAccount(new ListSource([]), W))).toEqual([]);
  });

  it('surfaces a mid-stream source error with a cursor, and resuming loses and repeats nothing', async () => {
    const records = loadRecords(W);
    const failAfter = Math.floor(records.length / 2);
    const flaky = new ListSource(records, failAfter);

    const before: LedgerEvent[] = [];
    let interrupted: StreamInterruptedError | undefined;
    try {
      for await (const e of classifyAccount(flaky, W)) before.push(e);
    } catch (error) {
      if (error instanceof StreamInterruptedError) interrupted = error;
      else throw error;
    }
    expect(interrupted).toBeInstanceOf(StreamInterruptedError);
    expect(interrupted?.code).toBe('stream_interrupted');
    expect((interrupted?.cause as Error).message).toBe('connection reset');
    expect(interrupted?.cursor).toBeDefined();
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThan(expected.length);

    const resumed = await collect(
      classifyAccount(new ListSource(records), W, { cursor: interrupted?.cursor as string }),
    );
    expect([...before, ...resumed]).toEqual(expected);
  });

  it('reports the starting cursor if the source fails before any transaction completes', async () => {
    const records = loadRecords(W);
    const flaky = new ListSource(records, 2);
    const error = await collect(classifyAccount(flaky, W)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamInterruptedError);
    expect((error as StreamInterruptedError).cursor).toBeUndefined();
  });

  it('rejects a bad address, and a secret-key-shaped one, before asking the source for anything', async () => {
    const source = new ListSource(loadRecords(W));
    await expect(collect(classifyAccount(source, 'nope'))).rejects.toBeInstanceOf(
      InvalidAddressError,
    );
    const secret = StrKey.encodeEd25519SecretSeed(new Uint8Array(32).fill(3));
    await expect(collect(classifyAccount(source, secret))).rejects.toBeInstanceOf(
      SecretKeyInputError,
    );
    expect(source.pulled).toBe(0);
  });

  it('propagates a malformed record as a typed error', async () => {
    const records = structuredClone(loadRecords(W));
    const op = records.find((r) => r.kind === 'operation' && r.data['type'] === 'payment');
    if (!op) throw new Error('no payment');
    delete op.data['amount'];
    await expect(collect(classifyAccount(new ListSource(records), W))).rejects.toBeInstanceOf(
      MalformedRecordError,
    );
  });

  it('fails with a typed error for an address that has no fixture', async () => {
    await expect(
      collect(classifyAccount(new FixtureSource(FIXTURE_DIR), Keypair.random().publicKey())),
    ).rejects.toThrow('No fixture file');
  });
});
