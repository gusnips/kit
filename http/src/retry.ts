/**
 * `@gusnips/http/retry`: whether a failed request is worth a second attempt, and when.
 *
 * This is AGENTS.md's invariant 8, one layer down from `@gusnips/react`, so a zero-dependency SDK
 * can follow the same rule as the app: it imports nothing, and a generator can copy the file
 * into an SDK whole. Five SDKs in one fleet each wrote their own, and each missed part of it:
 * none retried a 408, none read an explicit `retryAfterSecs: null`, three read the body's wait
 * before the header, and the one that sent an idempotency key retried writes that had none.
 *
 * Every function reads an error by its fields, not its class: `status`, `code`, `details` (the
 * envelope's), and `retryAfterSecs` (the `Retry-After` header, parsed). An error with no HTTP
 * `status` is a request that got no answer at all: offline, DNS, a dropped connection.
 */

export interface RetryOptions {
  /**
   * Whether the request may run twice: a read, or a write that carries an idempotency key the
   * server honours. Required, because a default either way is wrong for half the calls, and the
   * wrong half of "yes" sends a second message or charges twice.
   *
   * When `false`, only an answer proving nothing ran is retried: 408, 425 or 429. A failure with
   * no answer, or a 5xx, may have run the write already.
   */
  repeatable: boolean;
  /**
   * Error codes that mean "this limit does not clear by waiting": a spent monthly quota, a
   * balance to top up. They usually arrive as 402 or 429, and the status alone cannot tell them
   * from a burst limit. Not needed where the server sends `details.retryAfterSecs: null`.
   */
  durableCodes?: readonly string[];
  /**
   * The longest stated wait still worth retrying. Default 10 seconds. A burst limit that clears
   * in two seconds is worth sitting out; a limit that clears in an hour is an answer to show.
   */
  maxWaitSecs?: number;
}

/** Statuses that say the request was not run and a later one can be: timeout, too early, busy. */
const NOT_NOW = new Set([408, 425, 429]);

const DEFAULT_MAX_WAIT_SECS = 10;

/**
 * Should this failure be retried?
 *
 *     if (attempt < 3 && isRetryable(error, { repeatable: method === "GET" || !!key }))
 */
export function isRetryable(error: unknown, options: RetryOptions): boolean {
  const { repeatable, durableCodes = [], maxWaitSecs = DEFAULT_MAX_WAIT_SECS } = options;
  const status = statusOf(error);
  // No answer at all: nothing about it is a refusal, but a write may have landed before the
  // connection dropped.
  if (status === null) return repeatable;

  const code = field(error, "code");
  if (typeof code === "string" && durableCodes.includes(code)) return false;

  // The server said waiting will never fix this. Checked before the stated wait, because a
  // limiter can attach a number to every 429 it sends, and the `null` came from whoever raised
  // this refusal.
  if (waitingNeverHelps(error)) return false;

  // It said when it clears. A wait too long to hold is an answer, not a hiccup.
  const wait = retryAfterSecs(error);
  if (wait !== null && wait > maxWaitSecs) return false;

  if (status >= 500) return repeatable;
  // A 409 is an answer, except the one that says when it clears: an idempotency key whose first
  // call is still running. Only a request that carries the key can get that answer, and waiting
  // is what fixes it. A 409 with no wait (a name already taken) stays final.
  if (status === 409) return repeatable && wait !== null;
  return NOT_NOW.has(status);
}

/**
 * How long before retry number `attemptIndex` (0 for the first): the server's stated wait when
 * there is one, an exponential backoff otherwise, and never less than the backoff. A
 * `Retry-After: 0` says "now", which is still too soon for a client that was just refused.
 *
 * The backoff lands at random between half and one and a half times 1 s·2ⁿ (capped at 30 s
 * first, so the spread survives the cap). Clients cut off by one outage all fail at the same
 * moment, and an exact backoff brings them all back at the same moment too, into a server that
 * is still coming up. A stated wait is not moved: the server picked that time, and earlier is
 * refused again.
 */
export function retryDelayMs(attemptIndex: number, error: unknown): number {
  const backoff = Math.min(1000 * 2 ** attemptIndex, 30_000) * (0.5 + Math.random());
  const wait = statusOf(error) === null ? null : retryAfterSecs(error);
  return wait === null ? backoff : Math.max(backoff, wait * 1000);
}

/**
 * Seconds until a refusal clears, wherever the API put them: the `Retry-After` header first,
 * because it is the standard place and a limiter writes it without being asked, then
 * `details.retryAfterSecs`, which some APIs send in the body instead.
 *
 * `null` means "no countdown to show". That is right both for a refusal that said nothing and
 * for one that said waiting never helps, and a countdown UI wants both to read the same.
 */
export function retryAfterSecs(error: unknown): number | null {
  const header = field(error, "retryAfterSecs");
  if (typeof header === "number" && Number.isFinite(header)) return header;
  const body = field(field(error, "details"), "retryAfterSecs");
  return typeof body === "number" && Number.isFinite(body) ? body : null;
}

/**
 * `Retry-After` in either form RFC 9110 allows: seconds, or an HTTP date. The date form is the
 * one that gets skipped, which turns a stated wait into none. A date already past is 0.
 *
 * Both forms round UP. A date names a whole second and the clock is somewhere inside the one
 * before, so rounding to nearest sends a retry up to half a second early, into the limiter that
 * refused it, about half the time. A wait until you are allowed rounds up; `@gusnips/server`'s
 * webhook sender has always read it that way. "1.5" is not the RFC's seconds form, but what it
 * asks for is plain, so it reads as 2.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  // Every HTTP date names a weekday and a month, so a value with no letters is the seconds form
  // or nothing. It must never reach `Date.parse`, which reads "-5", "1.5", "1/5" and "1 5" alike
  // as 5 January 2001, a date long past, and invents a wait of 0.
  if (!/[a-z]/i.test(raw)) {
    const secs = Math.ceil(Number(raw));
    return /^\+?\d+(\.\d+)?$/.test(raw) && Number.isSafeInteger(secs) ? secs : undefined;
  }

  // The third date form, asctime, carries no zone and means GMT. `Date.parse` reads a date with
  // no zone as local time, so outside UTC the wait comes out hours wrong.
  const at = Date.parse(/GMT|UTC|[+-]\d{4}$/i.test(raw) ? raw : `${raw} GMT`);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * Did the answer say that waiting will never fix it? A server sends `details.retryAfterSecs:
 * null` for a limit no time clears: a cap that frees when something is deleted, a slot that
 * frees when another job ends. Present-and-`null` is the whole test; an absent key said nothing.
 *
 * Not exported. It is not "is this refusal durable?": it knows nothing of `durableCodes` or of a
 * wait too long to hold, so a screen branching on it would disagree with `isRetryable`.
 */
function waitingNeverHelps(error: unknown): boolean {
  const details = field(error, "details");
  return (
    typeof details === "object" &&
    details !== null &&
    "retryAfterSecs" in details &&
    details.retryAfterSecs === null
  );
}

/** The HTTP status, or null for no answer. Below 100 is not one: auth-js reports "nothing came
 *  back" as status 0. */
function statusOf(error: unknown): number | null {
  const status = field(error, "status");
  return typeof status === "number" && status >= 100 ? status : null;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}
