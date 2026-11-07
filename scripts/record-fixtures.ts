/**
 * Records real testnet history as fixtures for ledgertax-core tests.
 *
 * Safety:
 *  - Testnet only: aborts unless the Horizon root reports the testnet passphrase.
 *  - Keypairs are generated in memory and discarded when the process exits. Secret keys are
 *    never printed, logged, written to disk or passed anywhere except to the SDK for signing.
 *  - Only public addresses and Horizon responses are written to test/fixtures/.
 *
 * Usage: pnpm fixtures:record   (optionally HORIZON_URL=<testnet horizon>)
 * See docs/FIXTURES.md.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Asset,
  Claimant,
  Horizon,
  Keypair,
  LiquidityPoolAsset,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  getLiquidityPoolId,
} from '@stellar/stellar-sdk';
import type { xdr } from '@stellar/stellar-sdk';

const HORIZON_URL = process.env['HORIZON_URL'] ?? 'https://horizon-testnet.stellar.org';
const SOURCE_NAME = 'horizon-testnet';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

const server = new Horizon.Server(HORIZON_URL);

/** Throwaway identities. Declared here, never serialised. */
const W = Keypair.random(); // the watched account most fixtures are recorded for
const B = Keypair.random(); // counterparty
const I = Keypair.random(); // issuer of the TEST asset and market maker
const M = Keypair.random(); // account that merges into W

const results: { step: string; ok: boolean; hash?: string; note?: string }[] = [];

function describeError(e: unknown): string {
  const data = (e as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response
    ?.data;
  if (data?.extras?.result_codes) return JSON.stringify(data.extras.result_codes);
  return e instanceof Error ? e.message.slice(0, 200) : 'unknown error';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fund(kp: Keypair): Promise<void> {
  await server.friendbot(kp.publicKey()).call();
}

interface SubmitOptions {
  memo?: string;
  /** Account that pays the fee through a fee-bump transaction. */
  feeBumpBy?: Keypair;
  /** Extra signers beyond the source. */
  alsoSign?: Keypair[];
}

async function submit(
  source: Keypair,
  ops: xdr.Operation[],
  opts: SubmitOptions = {},
): Promise<string> {
  const account = await server.loadAccount(source.publicKey());
  const fee = String(await server.fetchBaseFee());
  const builder = new TransactionBuilder(account, { fee, networkPassphrase: Networks.TESTNET });
  for (const op of ops) builder.addOperation(op);
  if (opts.memo !== undefined) builder.addMemo(Memo.text(opts.memo));
  const tx = builder.setTimeout(60).build();
  tx.sign(source);
  for (const kp of opts.alsoSign ?? []) tx.sign(kp);
  if (opts.feeBumpBy) {
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      opts.feeBumpBy,
      String(Number(fee) * 2),
      tx,
      Networks.TESTNET,
    );
    bump.sign(opts.feeBumpBy);
    await server.submitTransaction(bump);
    return Buffer.from(bump.hash()).toString('hex');
  }
  await server.submitTransaction(tx);
  return Buffer.from(tx.hash()).toString('hex');
}

async function step(name: string, run: () => Promise<string>): Promise<void> {
  try {
    const hash = await run();
    results.push({ step: name, ok: true, hash });
    console.log(`ok     ${name}`);
  } catch (e) {
    results.push({ step: name, ok: false, note: describeError(e) });
    console.log(`FAILED ${name}: ${describeError(e)}`);
  }
}

/** A step that is expected to be rejected at apply time but still land in a ledger. */
async function failedStep(name: string, run: () => Promise<string>): Promise<void> {
  try {
    await run();
    results.push({ step: name, ok: false, note: 'expected failure did not happen' });
    console.log(`FAILED ${name}: expected the transaction to fail`);
  } catch (e) {
    results.push({ step: name, ok: true, note: `failed as intended: ${describeError(e)}` });
    console.log(`ok     ${name} (failed on purpose: ${describeError(e)})`);
  }
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${HORIZON_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path.split('?')[0]} -> ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function records(page: Record<string, unknown>): Record<string, unknown>[] {
  const embedded = page['_embedded'] as { records?: Record<string, unknown>[] } | undefined;
  return embedded?.records ?? [];
}

function strip(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy['_links'];
  return copy;
}

interface FixtureRecord {
  source: string;
  ref: string;
  cursor: string;
  kind: 'transaction' | 'operation' | 'effect' | 'trade';
  time: string;
  ledger: number;
  data: Record<string, unknown>;
}

/** Reads one account's history from Horizon, oldest first: each transaction, its operations, its effects. */
async function recordAccount(address: string): Promise<FixtureRecord[]> {
  const out: FixtureRecord[] = [];
  const txs = records(
    await getJson(`/accounts/${address}/transactions?order=asc&limit=200&include_failed=true`),
  );
  // /accounts/{id}/transactions misses transactions where this account only had its offer
  // filled by someone else (maker-side fills). The account's effects do include them, so
  // discover those transactions through the effects and merge them in.
  const known = new Set(txs.map((t) => String(t['hash'])));
  let effectsPath: string | undefined = `/accounts/${address}/effects?order=asc&limit=200`;
  while (effectsPath) {
    const page = records(await getJson(effectsPath));
    if (page.length === 0) break;
    for (const ef of page) {
      const href = (ef['_links'] as { operation?: { href?: string } } | undefined)?.operation?.href;
      if (!href) continue;
      const op = (await (await fetch(href)).json()) as Record<string, unknown>;
      const hash = String(op['transaction_hash']);
      if (known.has(hash)) continue;
      known.add(hash);
      txs.push(await getJson(`/transactions/${hash}`));
    }
    const last = page[page.length - 1];
    effectsPath = `/accounts/${address}/effects?order=asc&limit=200&cursor=${String(last?.['paging_token'])}`;
  }
  txs.sort((a, b) => {
    const x = BigInt(String(a['paging_token']));
    const y = BigInt(String(b['paging_token']));
    return x < y ? -1 : x > y ? 1 : 0;
  });
  for (const tx of txs) {
    const hash = String(tx['hash']);
    const ledger = Number(tx['ledger']);
    const time = String(tx['created_at']);
    const add = (kind: FixtureRecord['kind'], r: Record<string, unknown>) => {
      out.push({
        source: SOURCE_NAME,
        ref: String(r['id']),
        cursor: `${kind}:${String(r['paging_token'])}`,
        kind,
        time: String(r['created_at'] ?? time),
        ledger,
        data: strip(r),
      });
    };
    add('transaction', tx);
    for (const op of records(
      await getJson(`/transactions/${hash}/operations?limit=200&include_failed=true`),
    )) {
      add('operation', op);
    }
    // Effects exist only for successful transactions.
    if (tx['successful'] === true) {
      for (const ef of records(await getJson(`/transactions/${hash}/effects?limit=200`))) {
        add('effect', ef);
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const root = await getJson('/');
  if (root['network_passphrase'] !== Networks.TESTNET) {
    throw new Error('Refusing to run: the Horizon URL is not the Stellar testnet.');
  }

  console.log('Funding throwaway accounts with Friendbot...');
  await fund(W);
  await fund(B);
  await fund(I);
  const TEST = new Asset('TEST', I.publicKey());
  const native = Asset.native();

  await step('payment out with a formula-looking memo', () =>
    submit(W, [Operation.payment({ destination: B.publicKey(), asset: native, amount: '100' })], {
      memo: '=1+1 test',
    }),
  );
  await step('payment in with a memo containing quotes and a comma', () =>
    submit(B, [Operation.payment({ destination: W.publicKey(), asset: native, amount: '50' })], {
      memo: 'hello, "quoted"',
    }),
  );
  await step('create account (W funds M)', () =>
    submit(W, [Operation.createAccount({ destination: M.publicKey(), startingBalance: '20' })]),
  );
  await step('account merge (M into W)', () =>
    submit(M, [Operation.accountMerge({ destination: W.publicKey() })]),
  );
  await step('change trust W', () => submit(W, [Operation.changeTrust({ asset: TEST })]));
  await step('change trust B', () => submit(B, [Operation.changeTrust({ asset: TEST })]));
  await step('issuer pays W 1000 TEST', () =>
    submit(I, [Operation.payment({ destination: W.publicKey(), asset: TEST, amount: '1000' })]),
  );
  await step('issuer pays B 1000 TEST', () =>
    submit(I, [Operation.payment({ destination: B.publicKey(), asset: TEST, amount: '1000' })]),
  );

  // Offers: W is the maker, B takes part of it; then B is the maker and W takes.
  await step('W manage sell offer (maker)', () =>
    submit(W, [
      Operation.manageSellOffer({
        selling: TEST,
        buying: native,
        amount: '100',
        price: '2',
        offerId: '0',
      }),
    ]),
  );
  await step('B manage buy offer fills W (W is maker)', () =>
    submit(B, [
      Operation.manageBuyOffer({
        selling: native,
        buying: TEST,
        buyAmount: '40',
        price: '2',
        offerId: '0',
      }),
    ]),
  );
  await step('B manage sell offer (maker)', () =>
    submit(B, [
      Operation.manageSellOffer({
        selling: TEST,
        buying: native,
        amount: '50',
        price: '1.5',
        offerId: '0',
      }),
    ]),
  );
  await step('W manage buy offer fills B (W is taker)', () =>
    submit(W, [
      Operation.manageBuyOffer({
        selling: native,
        buying: TEST,
        buyAmount: '20',
        price: '1.5',
        offerId: '0',
      }),
    ]),
  );
  await step('issuer places liquidity offer', () =>
    submit(I, [
      Operation.manageSellOffer({
        selling: TEST,
        buying: native,
        amount: '500',
        price: '1',
        offerId: '0',
      }),
    ]),
  );

  // Path payments through the order book.
  await step('path payment strict send (W sends XLM, B receives TEST)', () =>
    submit(W, [
      Operation.pathPaymentStrictSend({
        sendAsset: native,
        sendAmount: '10',
        destination: B.publicKey(),
        destAsset: TEST,
        destMin: '1',
        path: [],
      }),
    ]),
  );
  await step('path payment strict receive (W sends XLM, B receives TEST)', () =>
    submit(W, [
      Operation.pathPaymentStrictReceive({
        sendAsset: native,
        sendMax: '30',
        destination: B.publicKey(),
        destAsset: TEST,
        destAmount: '5',
        path: [],
      }),
    ]),
  );
  await step('path payment strict send (B sends XLM, W receives TEST)', () =>
    submit(B, [
      Operation.pathPaymentStrictSend({
        sendAsset: native,
        sendAmount: '10',
        destination: W.publicKey(),
        destAsset: TEST,
        destMin: '1',
        path: [],
      }),
    ]),
  );

  // Claimable balances in both directions.
  await step('W creates a claimable balance for B', () =>
    submit(W, [
      Operation.createClaimableBalance({
        asset: native,
        amount: '5',
        claimants: [new Claimant(B.publicKey())],
      }),
    ]),
  );
  await step('B claims W balance', async () => {
    const page = await getJson(`/claimable_balances?claimant=${B.publicKey()}&limit=10`);
    const id = records(page)[0]?.['id'];
    if (typeof id !== 'string') throw new Error('no claimable balance found for B');
    return submit(B, [Operation.claimClaimableBalance({ balanceId: id })]);
  });
  await step('B creates a claimable balance for W', () =>
    submit(B, [
      Operation.createClaimableBalance({
        asset: native,
        amount: '7',
        claimants: [new Claimant(W.publicKey())],
      }),
    ]),
  );
  await step('W claims B balance', async () => {
    const page = await getJson(`/claimable_balances?claimant=${W.publicKey()}&limit=10`);
    const id = records(page)[0]?.['id'];
    if (typeof id !== 'string') throw new Error('no claimable balance found for W');
    return submit(W, [Operation.claimClaimableBalance({ balanceId: id })]);
  });

  // Fee bump: W is the inner source, B pays the fee.
  await step('fee bump (B pays the fee for W)', () =>
    submit(W, [Operation.payment({ destination: B.publicKey(), asset: native, amount: '1' })], {
      feeBumpBy: B,
    }),
  );

  // Failed transaction: lands in a ledger and charges a fee, but changes nothing.
  await failedStep('failed payment (underfunded)', () =>
    submit(W, [Operation.payment({ destination: B.publicKey(), asset: native, amount: '900000' })]),
  );

  // Operations the MVP classifies as unknown.
  await step('set options (home domain)', () =>
    submit(W, [Operation.setOptions({ homeDomain: 'example.com' })]),
  );
  await step('liquidity pool deposit (best effort)', async () => {
    const pool = new LiquidityPoolAsset(native, TEST, 30);
    await submit(W, [Operation.changeTrust({ asset: pool })]);
    const poolId = Buffer.from(
      getLiquidityPoolId('constant_product', pool.getLiquidityPoolParameters()),
    ).toString('hex');
    return submit(W, [
      Operation.liquidityPoolDeposit({
        liquidityPoolId: poolId,
        maxAmountA: '10',
        maxAmountB: '10',
        minPrice: '0.1',
        maxPrice: '10',
      }),
    ]);
  });

  console.log('Waiting briefly for Horizon to ingest...');
  await sleep(6000);

  await mkdir(outDir, { recursive: true });
  const files: { address: string; file: string; role: string; records: number }[] = [];
  for (const [kp, role] of [
    [W, 'main watched account'],
    [M, 'account that merged into the main account'],
  ] as const) {
    const address = kp.publicKey();
    const recs = await recordAccount(address);
    const file = `${address}.json`;
    await writeFile(join(outDir, file), `${JSON.stringify(recs, null, 2)}\n`);
    files.push({ address, file, role, records: recs.length });
  }
  // Public keys only. B and I are listed so a reader can match counterparties in the records.
  const manifest = {
    network: 'testnet',
    recordedAt: new Date().toISOString(),
    horizon: HORIZON_URL,
    counterparties: { B: B.publicKey(), issuer: I.publicKey() },
    files,
    steps: results,
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const failed = results.filter((r) => !r.ok);
  console.log(
    `Done. ${results.length - failed.length}/${results.length} steps ok. Wrote ${files.length} fixture files.`,
  );
  if (failed.length > 0) console.log(`Steps that failed: ${failed.map((f) => f.step).join('; ')}`);
}

main().catch((e: unknown) => {
  console.error(`Fixture recording failed: ${describeError(e)}`);
  process.exitCode = 1;
});
