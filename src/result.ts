/** A success-or-failure value that does not throw. */
export type Result<T, E extends Error> = { ok: true; value: T } | { ok: false; error: E };
