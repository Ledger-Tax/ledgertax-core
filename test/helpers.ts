import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchOptions, HistorySource, RawRecord } from '../src/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Folder holding the recorded fixture files. */
export const FIXTURE_DIR = dir;

interface Manifest {
  counterparties: { B: string; issuer: string };
  files: { address: string; file: string; role: string }[];
}

const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;

/** The watched main account, the merged account, and the counterparties of the fixtures. */
export const W = manifest.files.find((f) => f.role === 'main watched account')?.address ?? '';
export const M =
  manifest.files.find((f) => f.role.startsWith('account that merged'))?.address ?? '';
export const B = manifest.counterparties.B;
export const ISSUER = manifest.counterparties.issuer;
export const TEST_ASSET = `TEST:${ISSUER}`;

/** Reads a fixture file and splits it into per-transaction groups (transaction record first). */
export function loadGroups(address: string): RawRecord[][] {
  const file = manifest.files.find((f) => f.address === address)?.file ?? '';
  const records = JSON.parse(readFileSync(join(dir, file), 'utf8')) as RawRecord[];
  const groups: RawRecord[][] = [];
  for (const r of records) {
    if (r.kind === 'transaction') groups.push([r]);
    else groups[groups.length - 1]?.push(r);
  }
  return groups;
}

/** Finds the group that contains an operation of `type` (the nth one, 0-based). */
export function groupWithOp(address: string, type: string, nth = 0): RawRecord[] {
  const found = loadGroups(address).filter((g) =>
    g.some((r) => r.kind === 'operation' && r.data['type'] === type),
  );
  const group = found[nth];
  if (!group) throw new Error(`fixture has no ${type} #${nth}`);
  return group;
}

/** Returns a deep copy of a group so a test can break it without touching the shared data. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory source for tests. Pulls are counted; it can fail after N records. */
export class ListSource implements HistorySource {
  readonly name = 'list';
  pulled = 0;
  constructor(
    private readonly records: readonly RawRecord[],
    private readonly failAfter?: number,
  ) {}

  async *fetch(_address: string, opts: FetchOptions = {}): AsyncIterable<RawRecord> {
    let start = 0;
    if (opts.cursor !== undefined) {
      const at = this.records.findIndex((r) => r.cursor === opts.cursor);
      if (at < 0) throw new Error('unknown cursor');
      start = at + 1;
    }
    let served = 0;
    for (const record of this.records.slice(start)) {
      if (this.failAfter !== undefined && served >= this.failAfter) {
        throw new Error('connection reset');
      }
      served += 1;
      this.pulled += 1;
      yield record;
      await Promise.resolve(); // behave like a paged network source: yield to the event loop
    }
  }
}

/** All records of a fixture, flattened in file order. */
export function loadRecords(address: string): RawRecord[] {
  return loadGroups(address).flat();
}
