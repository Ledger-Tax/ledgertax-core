import { StrKey } from '@stellar/stellar-sdk';
import { InvalidAddressError, SecretKeyInputError } from './errors.js';
import type { Result } from './result.js';

/** Longest input we will even look at. A muxed address is 69 characters. */
const MAX_INPUT_LENGTH = 256;

/** A validated public address. */
export interface ParsedAddress {
  /** The account address (starts with G). For a muxed input this is the underlying account. */
  address: string;
  /** Set only when the input was a muxed (M...) address. */
  muxedId?: bigint;
}

/**
 * Returns true if the input has the shape of a Stellar secret key: 56 characters starting
 * with `S` (case-insensitive, base32 alphabet). It deliberately does not verify the
 * checksum, so a mistyped secret key is still caught. Never log or echo the input.
 *
 * @param input - any user-supplied text
 */
export function isLikelySecretKey(input: string): boolean {
  if (typeof input !== 'string') return false;
  return /^[Ss][A-Za-z2-7]{55}$/.test(input.trim());
}

/**
 * Validates user input as a Stellar public address. Accepts a G... account address or an
 * M... muxed address (returned as its underlying G address plus the muxed id). Secret-key-shaped
 * input is rejected with {@link SecretKeyInputError}; no error ever contains the input.
 *
 * @param input - any user-supplied text
 * @returns the parsed address, or a typed error
 */
export function parseStellarAddress(
  input: string,
): Result<ParsedAddress, InvalidAddressError | SecretKeyInputError> {
  if (typeof input !== 'string') return { ok: false, error: new InvalidAddressError() };
  if (isLikelySecretKey(input)) return { ok: false, error: new SecretKeyInputError() };

  const text = input.trim();
  if (text.length === 0 || text.length > MAX_INPUT_LENGTH) {
    return { ok: false, error: new InvalidAddressError() };
  }

  if (StrKey.isValidEd25519PublicKey(text)) {
    return { ok: true, value: { address: text } };
  }

  if (StrKey.isValidMed25519PublicKey(text)) {
    const raw = StrKey.decodeMed25519PublicKey(text); // 32-byte key + 8-byte big-endian id
    const address = StrKey.encodeEd25519PublicKey(raw.slice(0, 32));
    const id = new DataView(raw.buffer, raw.byteOffset + 32, 8).getBigUint64(0, false);
    return { ok: true, value: { address, muxedId: id } };
  }

  return { ok: false, error: new InvalidAddressError() };
}
