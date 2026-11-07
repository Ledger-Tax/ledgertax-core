import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FixtureSource, isLikelySecretKey, rawRecordSchema } from '../src/index.js';
import type { RawRecord } from '../src/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface Manifest {
  network: string;
  files: { address: string; file: string; role: string; records: number }[];
}
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
const main = manifest.files.find((f) => f.role === 'main watched account');
const merged = manifest.files.find((f) => f.role.startsWith('account that merged'));

async function load(address: string): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of new FixtureSource(dir).fetch(address)) out.push(r);
  return out;
}

function dataOf(r: RawRecord, key: string): unknown {
  return r.data[key];
}

describe('recorded testnet fixtures', () => {
  it('are recorded from testnet and listed in the manifest', () => {
    expect(manifest.network).toBe('testnet');
    expect(main).toBeDefined();
    expect(merged).toBeDefined();
  });

  it('load through FixtureSource with every record valid and the stated count', async () => {
    for (const f of manifest.files) {
      const records = await load(f.address);
      expect(records.length).toBe(f.records);
      for (const r of records) expect(rawRecordSchema.safeParse(r).success).toBe(true);
    }
  });

  it('have unique cursors and non-decreasing ledgers (so resume works)', async () => {
    for (const f of manifest.files) {
      const records = await load(f.address);
      expect(new Set(records.map((r) => r.cursor)).size).toBe(records.length);
      const ledgers = records.map((r) => r.ledger ?? 0);
      expect(ledgers).toEqual([...ledgers].sort((a, b) => a - b));
    }
  });

  it('cover every operation type the MVP classifies, plus operations that must become unknown', async () => {
    const records = await load(main?.address ?? '');
    const types = new Set(
      records.filter((r) => r.kind === 'operation').map((r) => String(dataOf(r, 'type'))),
    );
    for (const t of [
      'payment',
      'create_account',
      'account_merge',
      'path_payment_strict_send',
      'path_payment_strict_receive',
      'manage_sell_offer',
      'manage_buy_offer',
      'create_claimable_balance',
      'claim_claimable_balance',
      // not classified in the MVP, so they must become `unknown`:
      'change_trust',
      'set_options',
      'liquidity_pool_deposit',
    ]) {
      expect(types, `operation type ${t}`).toContain(t);
    }
  });

  it('include a failed transaction, a fee bump paid by someone else, and a memo that looks like a formula', async () => {
    const txs = (await load(main?.address ?? '')).filter((r) => r.kind === 'transaction');
    expect(txs.some((t) => dataOf(t, 'successful') === false)).toBe(true);
    expect(
      txs.some(
        (t) =>
          dataOf(t, 'fee_bump_transaction') !== undefined &&
          dataOf(t, 'fee_account') !== dataOf(t, 'source_account'),
      ),
    ).toBe(true);
    expect(txs.some((t) => String(dataOf(t, 'memo') ?? '').startsWith('='))).toBe(true);
  });

  it('include a maker-side fill that the account transactions list alone would miss', async () => {
    // Records are stored as: transaction, its operations, its effects. Track the current tx.
    let currentTxSource: unknown;
    let makerFill = false;
    for (const r of await load(main?.address ?? '')) {
      if (r.kind === 'transaction') currentTxSource = dataOf(r, 'source_account');
      if (
        r.kind === 'effect' &&
        dataOf(r, 'type') === 'trade' &&
        dataOf(r, 'account') === main?.address &&
        currentTxSource !== main?.address
      ) {
        makerFill = true;
      }
    }
    expect(makerFill).toBe(true);
  });

  it('contain the merge from the other side (account removed)', async () => {
    const records = await load(merged?.address ?? '');
    expect(
      records.some((r) => r.kind === 'operation' && dataOf(r, 'type') === 'account_merge'),
    ).toBe(true);
  });

  it('contain no secret-shaped strings anywhere', async () => {
    const found: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'string') {
        if (isLikelySecretKey(v)) found.push(path);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${path}[${i}]`));
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    for (const f of manifest.files) walk(await load(f.address), f.role);
    walk(manifest, 'manifest');
    expect(found).toEqual([]);
  });
});

describe('fixture structure the classifier relies on', () => {
  it('ties every effect to an operation of the same transaction by id, and operation index by paging token', async () => {
    for (const f of manifest.files) {
      let opIds = new Set<string>();
      let txPaging = 0n;
      let opCount = 0;
      for (const r of await load(f.address)) {
        if (r.kind === 'transaction') {
          opIds = new Set();
          txPaging = BigInt(String(dataOf(r, 'paging_token')));
          opCount = Number(dataOf(r, 'operation_count'));
        } else if (r.kind === 'operation') {
          const id = String(dataOf(r, 'id'));
          opIds.add(id);
          const index = BigInt(id) - txPaging - 1n;
          expect(index >= 0n && index < BigInt(opCount)).toBe(true);
        } else if (r.kind === 'effect') {
          const prefix = String(dataOf(r, 'id')).split('-')[0] ?? '';
          expect(opIds.has(prefix.replace(/^0+/, ''))).toBe(true);
        }
      }
    }
  });
});
