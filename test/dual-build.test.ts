import { createRequire } from 'node:module';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** tsup matches files with forward slashes only, even on Windows. */
const slash = (p: string): string => p.replaceAll('\\', '/');
// Inside node_modules so the built files can resolve the package's own dependencies.
const outDir = join(root, 'node_modules', '.cache', 'ledgertax-dual-build-test');

const PUBLIC_API = [
  'FixtureSource',
  'InvalidAddressError',
  'MalformedRecordError',
  'SecretKeyInputError',
  'StreamInterruptedError',
  'classifyAccount',
  'classifyTransaction',
  'isLikelySecretKey',
  'parseStellarAddress',
];

type Api = Record<string, unknown> & {
  parseStellarAddress: (input: string) => { ok: boolean };
  isLikelySecretKey: (input: string) => boolean;
};

describe('dual ESM / CJS build', () => {
  let esm: Api;
  let cjs: Api;

  beforeAll(async () => {
    await build({
      entry: [slash(join(root, 'src', 'index.ts'))],
      format: ['esm', 'cjs'],
      outDir: slash(outDir),
      dts: false,
      clean: true,
      silent: true,
      config: false,
      tsconfig: slash(join(root, 'tsconfig.json')),
    });
    esm = (await import(pathToFileURL(join(outDir, 'index.js')).href)) as Api;
    cjs = createRequire(import.meta.url)(join(outDir, 'index.cjs')) as Api;
  }, 60_000);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('exports the same public API from both builds', () => {
    for (const name of PUBLIC_API) {
      expect(typeof esm[name], `esm ${name}`).toBe('function');
      expect(typeof cjs[name], `cjs ${name}`).toBe('function');
    }
    expect(Object.keys(cjs).sort()).toEqual(Object.keys(esm).sort());
  });

  it('behaves the same from both builds, including rejecting a secret-shaped string', () => {
    const secretShaped = `S${'A'.repeat(55)}`;
    for (const api of [esm, cjs]) {
      expect(api.isLikelySecretKey(secretShaped)).toBe(true);
      expect(api.parseStellarAddress(secretShaped).ok).toBe(false);
      expect(api.parseStellarAddress('not an address').ok).toBe(false);
    }
  });
});
