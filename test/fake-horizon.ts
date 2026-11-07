import { W, loadGroups } from './helpers.js';
import type { RawRecord } from '../src/index.js';

type Json = Record<string, unknown>;

/** Orders Horizon paging tokens: plain ids or `opid-index` effect tokens. */
function tokenKey(token: string): [bigint, number] {
  const [id = '0', idx = '0'] = token.split('-');
  return [BigInt(id), Number(idx)];
}
function compare(a: string, b: string): number {
  const [x, i] = tokenKey(a);
  const [y, j] = tokenKey(b);
  return x < y ? -1 : x > y ? 1 : i - j;
}

export interface FakeHorizon {
  fetch: typeof fetch;
  /** Hashes of the transactions the account list leaves out (maker-side fills). */
  hiddenHashes: string[];
  /** Every URL requested, path and query. */
  requests: string[];
  /** Paths whose next request should fail with this status first (consumed once each). */
  failures: Map<string, { status: number; times: number; retryAfter?: string }>;
}

/**
 * A fake Horizon serving the recorded fixture of the main account. Like the real server, the
 * account's transaction list leaves out maker-side fills (transactions by someone else in which
 * the account only had a resting offer filled); its effects list still contains them.
 */
export function fakeHorizon(options: { passphrase?: string } = {}): FakeHorizon {
  const groups = loadGroups(W);
  const byKind = (g: RawRecord[], kind: string) => g.filter((r) => r.kind === kind);
  const txOf = (g: RawRecord[]): Json =>
    (g.find((r) => r.kind === 'transaction') as RawRecord).data;

  const isMakerFill = (g: RawRecord[]): boolean => {
    const tx = txOf(g);
    if (tx['source_account'] === W) return false;
    const mine = byKind(g, 'effect').filter((r) => r.data['account'] === W);
    return mine.length > 0 && mine.every((r) => r.data['type'] === 'trade');
  };

  const listed = groups.filter((g) => !isMakerFill(g)).map(txOf);
  const allEffectsOfW = groups
    .flatMap((g) => byKind(g, 'effect'))
    .filter((r) => r.data['account'] === W)
    .map((r) => r.data);

  const requests: string[] = [];
  const failures = new Map<string, { status: number; times: number; retryAfter?: string }>();

  function page(records: Json[], url: URL): Json {
    const cursor = url.searchParams.get('cursor');
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const sorted = [...records].sort((a, b) =>
      compare(String(a['paging_token']), String(b['paging_token'])),
    );
    const rest =
      cursor === null
        ? sorted
        : sorted.filter((r) => compare(String(r['paging_token']), cursor) > 0);
    return { _embedded: { records: rest.slice(0, limit) } };
  }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const fake: FakeHorizon = {
    hiddenHashes: groups.filter(isMakerFill).map((g) => String(txOf(g)['hash'])),
    requests,
    failures,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = url.pathname;
      requests.push(`${path}${url.search}`);

      const failure = failures.get(path);
      if (failure && failure.times > 0) {
        failure.times -= 1;
        return json(
          { title: 'failure' },
          failure.status,
          failure.retryAfter ? { 'retry-after': failure.retryAfter } : {},
        );
      }

      if (path === '/') {
        return json({
          horizon_version: '30.0.0-test',
          network_passphrase: options.passphrase ?? 'Test SDF Network ; September 2015',
          history_elder_ledger: 128,
          history_latest_ledger: 999999,
        });
      }
      let m = /^\/accounts\/([^/]+)\/(transactions|effects)$/.exec(path);
      if (m) {
        if (m[1] !== W) return json({ title: 'Resource Missing' }, 404);
        return json(page(m[2] === 'transactions' ? listed : allEffectsOfW, url));
      }
      m = /^\/transactions\/([^/]+)\/(operations|effects)$/.exec(path);
      if (m) {
        const g = groups.find((x) => txOf(x)['hash'] === m?.[1]);
        if (!g) return json({ title: 'Resource Missing' }, 404);
        return json(
          page(
            byKind(g, m[2] === 'operations' ? 'operation' : 'effect').map((r) => r.data),
            url,
          ),
        );
      }
      m = /^\/transactions\/([^/]+)$/.exec(path);
      if (m) {
        const g = groups.find((x) => txOf(x)['hash'] === m?.[1]);
        return g ? json(txOf(g)) : json({ title: 'Resource Missing' }, 404);
      }
      m = /^\/operations\/(\d+)$/.exec(path);
      if (m) {
        const op = groups
          .flatMap((g) => byKind(g, 'operation'))
          .find((r) => r.data['id'] === m?.[1]);
        return op ? json(op.data) : json({ title: 'Resource Missing' }, 404);
      }
      return json({ title: 'Not Found' }, 404);
    }) as typeof fetch,
  };
  return fake;
}
