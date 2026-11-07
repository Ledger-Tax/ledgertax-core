import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  InvalidAddressError,
  SecretKeyInputError,
  isLikelySecretKey,
  parseStellarAddress,
} from '../src/index.js';

// Throwaway values generated in memory for each run. Secrets are never printed or stored.
const publicKey = Keypair.random().publicKey();
const secretShaped = StrKey.encodeEd25519SecretSeed(new Uint8Array(32).fill(7));

function muxed(id: bigint): string {
  const raw = new Uint8Array(40);
  raw.set(StrKey.decodeEd25519PublicKey(publicKey), 0);
  new DataView(raw.buffer).setBigUint64(32, id, false);
  return StrKey.encodeMed25519PublicKey(raw);
}

describe('isLikelySecretKey', () => {
  it('detects a valid secret key', () => {
    expect(isLikelySecretKey(secretShaped)).toBe(true);
  });
  it('detects a secret key with a bad checksum, with whitespace and in lower case', () => {
    expect(isLikelySecretKey(`S${'A'.repeat(55)}`)).toBe(true);
    expect(isLikelySecretKey(`  ${secretShaped}\n`)).toBe(true);
    expect(isLikelySecretKey(secretShaped.toLowerCase())).toBe(true);
  });
  it('does not flag public keys, short strings or empty input', () => {
    expect(isLikelySecretKey(publicKey)).toBe(false);
    expect(isLikelySecretKey('S123')).toBe(false);
    expect(isLikelySecretKey('')).toBe(false);
  });
});

describe('parseStellarAddress', () => {
  it('accepts a public key', () => {
    expect(parseStellarAddress(publicKey)).toEqual({ ok: true, value: { address: publicKey } });
  });
  it('trims surrounding whitespace', () => {
    expect(parseStellarAddress(`  ${publicKey}\n`)).toEqual({
      ok: true,
      value: { address: publicKey },
    });
  });
  it('accepts a muxed address and returns the base account and id', () => {
    expect(parseStellarAddress(muxed(123456789n))).toEqual({
      ok: true,
      value: { address: publicKey, muxedId: 123456789n },
    });
  });
  it('handles the largest muxed id', () => {
    const r = parseStellarAddress(muxed(2n ** 64n - 1n));
    expect(r.ok && r.value.muxedId).toBe(2n ** 64n - 1n);
  });
  it('rejects garbage, empty, oversized and non-string input', () => {
    for (const bad of ['', '   ', 'hello', 'G123', 'G'.repeat(56), 'x'.repeat(1000)]) {
      const r = parseStellarAddress(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(InvalidAddressError);
    }
    expect(parseStellarAddress(42 as unknown as string).ok).toBe(false);
  });
  it('rejects a public key with a corrupted checksum', () => {
    const bad = `${publicKey.slice(0, -1)}${publicKey.endsWith('A') ? 'B' : 'A'}`;
    expect(parseStellarAddress(bad).ok).toBe(false);
  });
  it('rejects a secret key and never echoes it', () => {
    const r = parseStellarAddress(secretShaped);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBeInstanceOf(SecretKeyInputError);
    expect(r.error.code).toBe('secret_key_rejected');
    expect(r.error.message).not.toContain(secretShaped);
    expect(r.error.stack ?? '').not.toContain(secretShaped);
  });
  it('does not echo invalid input either', () => {
    const r = parseStellarAddress('not-an-address-12345');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).not.toContain('12345');
  });
});
