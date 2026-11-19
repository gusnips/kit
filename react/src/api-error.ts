import type { ApiErrorBody } from "@gusnips/http";

/**
 * A refusal, with the whole envelope intact.
 *
 * `code` is what the UI switches on, `messageKey` is what gets localized, and `details` carries the
 * parts that make a refusal actionable, such as the `resetAt` on a 429 or the plan that lifts a
 * 402. Keeping all of it means a caller never has to re-parse a response body that has already been
 * read once.
 *
 * A real `class` and not an interface with a factory: one donor used the interface shape, which
 * works until something needs `instanceof` across a module boundary or wants a subclass.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly messageKey: string | undefined;
  readonly params: Record<string, string | number> | undefined;
  readonly details: unknown;
  readonly requestId: string | undefined;
  /**
   * Seconds until this refusal clears, when the answer said so.
   *
   * Read from the `Retry-After` HEADER, which is where HTTP puts it and where a rate limiter
   * written by anyone puts it. The second migration is why this exists: that API sends
   * `Retry-After: 60` on every 429 and nothing in its body, so the package's only reader looked in
   * `details.retryAfterSecs`, the first donor's convention, and found nothing, and both the copy
   * and the retry rule were flying blind on the one refusal that states its own expiry. Two
   * conventions, same fact; `retryAfterSecs` from `@gusnips/http/retry` reads either.
   */
  readonly retryAfterSecs: number | undefined;

  /**
   * Whether the answer brought a message of its own. False when `message` is only this class's
   * `Request failed (N)`: a gateway's HTML page, an empty body, an envelope without a message.
   *
   * A screen that shows `message` checks this first, because that fallback is English and written
   * for a log. `code` cannot answer it: an API also writes code-less refusals for people ("Mensagem
   * vazia"), so "no code" is not "no message". The second migration's three apps each compared
   * `message` against the fallback string by hand until this existed.
   */
  readonly hasMessage: boolean;

  /**
   * The client raised this itself to stop a caller while it was already handling the situation.
   * Today this is the 401 thrown after a dead session, where the person is already on their way to
   * the sign-in page.
   *
   * It is control flow, not a fault. Exception reporting should skip it, and an error surface
   * should not ask somebody to retry something that is not broken. One donor had this and it is
   * the difference between a clean sign-out and a crash report every time a session expires.
   */
  readonly expected: boolean;

  constructor(
    status: number,
    body: ApiErrorBody["error"] | null,
    opts: {
      requestId?: string;
      expected?: boolean;
      message?: string;
      retryAfterSecs?: number;
    } = {},
  ) {
    const given = opts.message ?? body?.message;
    super(given ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.code;
    this.messageKey = body?.messageKey;
    this.params = body?.params;
    this.details = body?.details;
    this.requestId = opts.requestId;
    this.retryAfterSecs = opts.retryAfterSecs;
    this.expected = opts.expected ?? false;
    // An empty string is no message either: auth errors arrive with `message: ""`.
    this.hasMessage = Boolean(given);
  }
}

/**
 * A request aborted by the caller's own `AbortController` or a navigation that unmounted the
 * component waiting on it.
 *
 * Worth its own predicate because it is the one failure that must NOT be reported, retried or
 * shown: nobody is waiting for the answer. Distinguishing it from a real failure is what keeps
 * a route change from filling the console with errors nobody caused.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
