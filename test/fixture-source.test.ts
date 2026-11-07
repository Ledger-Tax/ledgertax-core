import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FixtureFormatError,
  FixtureNotFoundError,
  FixtureSource,
  InvalidAddressError,
  InvalidCursorError,
  SecretKeyInputError,
} from '../src/index.js';
import type { RawRecord } from '../src/index.js';

const address = Keypair.random().publicKey();
const records: RawRecord[] = [1, 2, 3, 4].map((n) => ({
  source: 'fixture',
  ref: `op-${n}`,
  cursor: `c${n}`,
  kind: 'operation',
  time: `2025-01-0${n}T00:00:00Z`,
  ledger: 100 + n,
  data: { type: 'payment', n },
}));

let dir: string;
let source: FixtureSource;

async function collect(it: AsyncIterable<RawRecord>): Promise<string[]> {
  const out: string[] = [];
  for await (const r of it) out.push(r.ref);
  return out;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ledgertax-fixture-'));
  await writeFile(join(dir, `${address}.json`), JSON.stringify(records));
  source = new FixtureSource(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FixtureSource', () => {
  it('yields all records in file order', async () => {
    expect(await collect(source.fetch(address))).toEqual(['op-1', 'op-2', 'op-3', 'op-4']);
  });
  it('resumes after a cursor', async () => {
    expect(await collect(source.fetch(address, { cursor: 'c2' }))).toEqual(['op-3', 'op-4']);
  });
  it('yields nothing when the cursor is the last record', async () => {
    expect(await collect(source.fetch(address, { cursor: 'c4' }))).toEqual([]);
  });
  it('respects limit and since', async () => {
    expect(await collect(source.fetch(address, { limit: 2 }))).toEqual(['op-1', 'op-2']);
    expect(await collect(source.fetch(address, { since: '2025-01-03T00:00:00Z' }))).toEqual([
      'op-3',
      'op-4',
    ]);
  });
  it('returns an empty stream for an empty fixture', async () => {
    const empty = Keypair.random().publicKey();
    await writeFile(join(dir, `${empty}.json`), '[]');
    expect(await collect(source.fetch(empty))).toEqual([]);
  });
  it('rejects an unknown cursor', async () => {
    await expect(collect(source.fetch(address, { cursor: 'nope' }))).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });
  it('rejects a missing fixture file', async () => {
    await expect(collect(source.fetch(Keypair.random().publicKey()))).rejects.toBeInstanceOf(
      FixtureNotFoundError,
    );
  });
  it('rejects malformed JSON and records that fail the schema', async () => {
    const a = Keypair.random().publicKey();
    await writeFile(join(dir, `${a}.json`), '{not json');
    await expect(collect(source.fetch(a))).rejects.toBeInstanceOf(FixtureFormatError);
    const b = Keypair.random().publicKey();
    await writeFile(join(dir, `${b}.json`), JSON.stringify([{ ref: 'x' }]));
    await expect(collect(source.fetch(b))).rejects.toBeInstanceOf(FixtureFormatError);
  });
  it('rejects invalid addresses, path tricks and secret-key-shaped input', async () => {
    await expect(collect(source.fetch('../etc/passwd'))).rejects.toBeInstanceOf(
      InvalidAddressError,
    );
    const secret = StrKey.encodeEd25519SecretSeed(new Uint8Array(32).fill(9));
    await expect(collect(source.fetch(secret))).rejects.toBeInstanceOf(SecretKeyInputError);
  });
});
