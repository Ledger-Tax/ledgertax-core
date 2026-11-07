/** Base class for every error this library throws or returns. */
export class LedgerTaxError extends Error {
  /** Stable machine-readable code. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The input is not a usable Stellar public address. The message never contains the input. */
export class InvalidAddressError extends LedgerTaxError {
  constructor(message = 'Not a valid Stellar public address.') {
    super('invalid_address', message);
  }
}

/** A source record is missing a field the classifier needs, or a field has the wrong shape. */
export class MalformedRecordError extends LedgerTaxError {
  /** Reference of the offending record. */
  readonly ref: string;

  constructor(ref: string, detail: string) {
    super('malformed_record', `Malformed record ${ref}: ${detail}`);
    this.ref = ref;
  }
}

/**
 * The input looks like a Stellar secret key. It is rejected and never echoed:
 * this tool only needs public addresses.
 */
export class SecretKeyInputError extends LedgerTaxError {
  constructor() {
    super(
      'secret_key_rejected',
      'This looks like a secret key. Never enter a secret key here; use the public address (starts with G).',
    );
  }
}
