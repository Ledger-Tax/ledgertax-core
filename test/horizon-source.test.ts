import { describe, expect, it } from 'vitest';
import {
  AccountNotFoundError,
  HorizonHttpError,
  HorizonResponseError,
  HorizonSource,
  InvalidAddressError,
  LedgerTaxError,
  classifyAccount,
  classifyTransaction,
} from '../src/index.js';
import type { LedgerEvent, RawRecord } from '../src/index.js';
import { fakeHorizon } from './fake-horizon.js';
import { W, loadGroups, loadRecords } from './helpers.js';

const BASE = 'https://horizon.example.test';
const noSleep = async (): Promise<void> => undefined;

async function records(source: HorizonSource, opts = {}): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of source.fetch(W, opts)) out.push(r);
  return out;
}
async function events(source: HorizonSource, opts = {}): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  for await (const e of classifyAccount(source, W, opts)) out.push(e);
  return out;
}
// The fixtures were recorded by the script, which labels its records 'horizon-testnet'.
const expected = loadGroups(W)
  .flatMap((g) => classifyTransaction(g, { address: W }))
  .map((e) => ({ ...e, raw: { ...e.raw, source: 'horizon' } }));

function make(
  fake = fakeHorizon(),
  extra: Partial<ConstructorParameters<typeof HorizonSource>[0]> = {},
) {
  return {
    fake,
    source: new HorizonSource({ baseUrl: BASE, fetch: fake.fetch, sleep: noSleep, ...extra }),
  };
}

describe('HorizonSource', () => {
  it('streams the same records, in the same order, as were recorded', async () => {
    const { source } = make();
    const got = await records(source);
    const want = loadRecords(W);
    expect(got.map((r) => r.cursor)).toEqual(want.map((r) => r.cursor));
    expect(got.map((r) => r.kind)).toEqual(want.map((r) => r.kind));
    expect(got[0]).toMatchObject({ source: 'horizon', kind: 'transaction' });
  });

  it('finds maker-side fills that the account transaction list omits', async () => {
    const { fake, source } = make();
    expect(fake.hiddenHashes.length).toBeGreaterThan(0);
    const got = await records(source);
    const hashes = new Set(
      got.filter((r) => r.kind === 'transaction').map((r) => String(r.data['hash'])),
    );
    for (const hidden of fake.hiddenHashes) expect(hashes.has(hidden)).toBe(true);
    // ...so classification gives exactly the events of the recorded history, trades included.
    expect(await events(source)).toEqual(expected);
  });

  it('would miss those trades if it used the transaction list alone (proves the merge matters)', async () => {
    const { fake } = make();
    const listOnly = await (
      await fake.fetch(`${BASE}/accounts/${W}/transactions?limit=200`)
    ).json();
    const listed = (
      listOnly as { _embedded: { records: { hash: string }[] } }
    )._embedded.records.map((t) => t.hash);
    for (const hidden of fake.hiddenHashes) expect(listed).not.toContain(hidden);
  });

  it('gives identical results with tiny pages (many requests)', async () => {
    const big = make();
    const small = make(fakeHorizon(), { pageSize: 2 });
    expect(await events(small.source)).toEqual(await events(big.source));
    expect(small.fake.requests.length).toBeGreaterThan(big.fake.requests.length);
  });

  it('resumes after a cursor without losing or repeating records', async () => {
    const { source } = make();
    const all = await records(source);
    const groupEnds = all
      .map((r, i) => [r, all[i + 1]] as const)
      .filter(([, next]) => next?.kind === 'transaction');
    for (const pick of [groupEnds[1], groupEnds[6], groupEnds[groupEnds.length - 2]]) {
      const last = pick?.[0];
      if (!last) throw new Error('missing group end');
      const rest = await records(source, { cursor: last.cursor });
      const at = all.findIndex((r) => r.cursor === last.cursor);
      expect(rest.map((r) => r.cursor)).toEqual(all.slice(at + 1).map((r) => r.cursor));
    }
  });

  it('resumes classifyAccount after a mid-stream failure', async () => {
    const { fake } = make();
    const realFetch = fake.fetch;
    let calls = 0;
    const failing = new HorizonSource({
      baseUrl: BASE,
      maxRetries: 0,
      sleep: noSleep,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        calls += 1;
        if (calls === 25) return new Response('{}', { status: 500 });
        return realFetch(...args);
      }) as typeof fetch,
    });
    const before: LedgerEvent[] = [];
    let cursor: string | undefined;
    try {
      for await (const e of classifyAccount(failing, W)) before.push(e);
    } catch (error) {
      cursor = (error as { cursor?: string }).cursor;
      expect((error as LedgerTaxError).code).toBe('stream_interrupted');
    }
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThan(expected.length);
    expect(cursor).toBeDefined();
    const resumed = await events(make().source, { cursor });
    expect([...before, ...resumed]).toEqual(expected);
  });

  it('honours since and limit', async () => {
    const { source } = make();
    const all = await records(source);
    const later = all.filter((r) => r.kind === 'transaction')[10];
    const sinceTime = String(later?.data['created_at']);
    const sinceRecords = await records(source, { since: sinceTime });
    expect(sinceRecords.length).toBeLessThan(all.length);
    expect(
      sinceRecords.every(
        (r) => r.kind !== 'transaction' || String(r.data['created_at']) >= sinceTime,
      ),
    ).toBe(true);
    expect(await records(source, { limit: 5 })).toHaveLength(5);
  });

  it('retries 503 and 429 (honouring Retry-After) and then succeeds', async () => {
    const delays: number[] = [];
    const fake = fakeHorizon();
    fake.failures.set(`/accounts/${W}/transactions`, { status: 503, times: 2 });
    fake.failures.set(`/accounts/${W}/effects`, { status: 429, times: 1, retryAfter: '2' });
    const source = new HorizonSource({
      baseUrl: BASE,
      fetch: fake.fetch,
      sleep: async (ms) => void delays.push(ms),
      retryDelayMs: 10,
    });
    expect(await events(source)).toEqual(expected);
    expect(delays).toContain(10);
    expect(delays).toContain(20);
    expect(delays).toContain(2000);
  });

  it('gives up with a typed error after the retries are used', async () => {
    const fake = fakeHorizon();
    fake.failures.set(`/accounts/${W}/transactions`, { status: 500, times: 99 });
    const source = new HorizonSource({
      baseUrl: BASE,
      fetch: fake.fetch,
      sleep: noSleep,
      maxRetries: 2,
    });
    await expect(records(source)).rejects.toBeInstanceOf(HorizonHttpError);
    expect(fake.requests.filter((r) => r.startsWith(`/accounts/${W}/transactions`))).toHaveLength(
      3,
    );
  });

  it('does not retry a client error such as 400', async () => {
    const fake = fakeHorizon();
    fake.failures.set(`/accounts/${W}/transactions`, { status: 400, times: 99 });
    const source = new HorizonSource({ baseUrl: BASE, fetch: fake.fetch, sleep: noSleep });
    await expect(records(source)).rejects.toMatchObject({ status: 400 });
    expect(fake.requests.filter((r) => r.startsWith(`/accounts/${W}/transactions`))).toHaveLength(
      1,
    );
  });

  it('reports an unknown account as AccountNotFoundError', async () => {
    const { source } = make();
    const other = loadGroups(W)[0]?.[0]?.data['source_account'] as string; // a real, valid address, not W
    const out: RawRecord[] = [];
    await expect(
      (async () => {
        for await (const r of source.fetch(other, {})) out.push(r);
      })(),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it('rejects a response with the wrong shape', async () => {
    const source = new HorizonSource({
      baseUrl: BASE,
      sleep: noSleep,
      fetch: (async () =>
        new Response(JSON.stringify({ nope: true }), { status: 200 })) as typeof fetch,
    });
    await expect(records(source)).rejects.toBeInstanceOf(HorizonResponseError);
  });

  it('rejects an invalid address before any request', async () => {
    const { fake, source } = make();
    await expect(
      (async () => {
        for await (const r of source.fetch('nope')) void r;
      })(),
    ).rejects.toBeInstanceOf(InvalidAddressError);
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects an unusable base URL or cursor', async () => {
    expect(() => new HorizonSource({ baseUrl: 'not a url' })).toThrow(LedgerTaxError);
    expect(() => new HorizonSource({ baseUrl: 'ftp://x.test' })).toThrow(LedgerTaxError);
    expect(() => new HorizonSource({ baseUrl: 'https://user:pw@x.test' })).toThrow(LedgerTaxError);
    const { source } = make();
    await expect(records(source, { cursor: 'bogus' })).rejects.toBeInstanceOf(LedgerTaxError);
  });

  it('reports what range the server covers', async () => {
    const { source } = make();
    expect(await source.coverage()).toEqual({
      baseUrl: BASE,
      networkPassphrase: 'Test SDF Network ; September 2015',
      horizonVersion: '30.0.0-test',
      historyElderLedger: 128,
      historyLatestLedger: 999999,
    });
  });
});
