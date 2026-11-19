import { retryDelayMs as delayFor, isRetryable as retryRule } from "@gusnips/http/retry";
import type { DefaultOptions } from "@tanstack/react-query";
import { ApiError } from "./api-error.ts";

/**
 * react-query defaults merged from three repos that each got part of this right.
 *
 * The default is three blind retries, which is wrong for an API that answers refusals
 * precisely: a 402, a 403 or a 451 says exactly the same thing three times, and a 429 we hammer
 * is a 429 we deserve. All three donors knew that much. What each knew alone:
 *
 * - one allowed **408** through, the only 4xx that a second attempt genuinely fixes;
 * - one refused to retry a 429 whose CODE says the limit is durable. A monthly quota or a spent balance clears by buying, not by waiting, so retrying burns another request against
 *   the limiter and cannot succeed;
 * - one set **`refetchOnReconnect`**, which none of the others had, and which is the single
 *   most useful refetch there is: coming back from a tunnel is exactly when the screen is stale.
 *
 * The second migration added the fourth rule, which no donor had: **when a 429 says how long,
 * believe it.** Its limiter answers `Retry-After: 60` on a per-minute window, and the default
 * backoff retries at 1s and 2s, sending two more requests that cannot succeed, both charged against
 * the same limiter, and three seconds added before the screen says anything. So a stated wait is
 * waited out when it is short, and is an ANSWER when it is not.
 *
 * The fifth rule came from the server half of this fleet rather than from a donor: a refusal can
 * state that waiting will never fix it at all, by sending `details.retryAfterSecs: null`. Read as
 * "did not say how long", as every version before this one did, that 429 is retried against a limit
 * no amount of time moves.
 *
 * This is invariant 8. The rule itself lives in `@gusnips/http/retry`, so an SDK with no React
 * in it follows the same one; what is here is the binding to react-query.
 */

export interface QueryDefaultsOptions {
  /**
   * Error codes for limits that do not clear by waiting, such as a spent monthly quota or a balance
   * that needs topping up. They usually arrive as 402 or 429; the status alone cannot tell them
   * apart from a burst limit, which is why the caller names them.
   *
   * Only needed where the server does not say so itself. One that sends
   * `details.retryAfterSecs: null` has already made the claim and `shouldRetry` reads it, which
   * is one entry fewer to keep in step with a backend this app does not own.
   */
  durableLimitCodes?: readonly string[];
  /** How many times to retry a transient failure. Two donors used 2, one used 1. */
  maxRetries?: number;
  /**
   * Longest stated wait still worth retrying. Default 10 seconds.
   *
   * Only applies when the refusal named its own expiry (`Retry-After`, or `retryAfterSecs` in the
   * body). A burst limit that clears in two seconds is worth sitting out; a monthly ceiling that
   * clears in an hour is an answer, and holding a spinner for it helps nobody. Show the wait
   * instead, which is what `humanizeWait` is for.
   */
  maxRetryWaitSecs?: number;
  staleTime?: number;
  gcTime?: number;
  /**
   * Left to the caller on purpose. A dashboard someone leaves open wants it on; a console
   * whose data changes only when the operator changes it wants it off, and one donor turned it
   * off deliberately. There is no right answer to inherit.
   */
  refetchOnWindowFocus?: boolean;
}

/**
 * Should this failure be retried?
 *
 * Exported on its own because an app with its own QueryClient config still wants this rule, and
 * because the describer derives the control it offers from it.
 */
export function shouldRetry(
  error: unknown,
  durableLimitCodes: readonly string[] = [],
  maxRetryWaitSecs?: number,
): boolean {
  // Every caller here is a query, or a person pressing "try again", so the request may run twice.
  return retryRule(answerOf(error), {
    repeatable: true,
    durableCodes: durableLimitCodes,
    maxWaitSecs: maxRetryWaitSecs,
  });
}

/**
 * How long before the next attempt: the server's stated wait when there is one, an exponential
 * backoff with jitter otherwise, and never less than the backoff. A `Retry-After: 0` is a server
 * saying "immediately", which for a client that just got refused is still too soon.
 */
export function retryDelayMs(attemptIndex: number, error: unknown): number {
  return delayFor(attemptIndex, answerOf(error));
}

/**
 * Only this client's `ApiError` is an answer. The shared rule reads any error by its fields, so a
 * vendor's error with a `status` of its own would count as one — and the describer reads anything
 * that is not an `ApiError` as a request that never landed, offering "try again" where the retry
 * rule would refuse. Handing the rule `null` keeps the two reading one failure the same way.
 */
function answerOf(error: unknown): ApiError | null {
  return error instanceof ApiError ? error : null;
}

export function queryDefaults({
  durableLimitCodes = [],
  maxRetries = 2,
  maxRetryWaitSecs,
  staleTime = 2 * 60 * 1000,
  gcTime = 10 * 60 * 1000,
  refetchOnWindowFocus = false,
}: QueryDefaultsOptions = {}): DefaultOptions {
  return {
    queries: {
      staleTime,
      gcTime,
      retry: (failureCount, error) =>
        failureCount < maxRetries && shouldRetry(error, durableLimitCodes, maxRetryWaitSecs),
      retryDelay: retryDelayMs,
      refetchOnWindowFocus,
      refetchOnReconnect: true,
    },
    // A mutation is not idempotent by default. Retrying one that already reached the server is
    // how a customer gets charged twice; all three donors agreed on this without discussion.
    // And a write pressed offline fails at once instead of waiting for the connection. React
    // Query's own mode ("online") holds it, then sends it by itself when the browser or NetInfo
    // says online again, even after its screen is gone. Two adopters set "always" by hand after
    // finding that, one on eight mutations one at a time, and missed the ones that spend.
    mutations: { retry: false, networkMode: "always" },
  };
}

/**
 * What a screen should show for one query: still waiting, failed with nothing to show, or ready.
 * When it is ready, `refreshError` says whether the last refresh failed.
 *
 * **Never gate a screen on `isError`.** It is also true when a BACKGROUND refetch fails over data
 * already on screen after a window regains focus, a poll or the invalidation after a save. So
 * `isError ? <failure panel> : <data>` throws away what the reader was looking at over one blip.
 * The adopters that had noticed each wrote `isLoadingError` beside a comment saying so; the ones
 * that had not were a boundary and a great many inline ternaries. A refresh that failed is not a
 * page that failed: the data is still real, and `refreshError` is there to say it may be stale.
 *
 * `waiting` is anything with no data and no error, and that includes a query switched off until
 * something upstream answers. `isLoading` is false there, because it means `isPending &&
 * isFetching`, which is how `isLoading ? <spinner> : <list>` shows an empty list as though the
 * answer were "nothing".
 *
 * Only `data` and `error` are read, and that is react-query's own definition, not a shortcut:
 * every success clears `error`, and a refetch after a failed first load goes back to pending. So
 * an error beside data IS `isRefetchError`, and an error without data IS `isLoadingError`. It
 * takes any query result, infinite ones included, and a test passes a plain object.
 *
 * A missing `error` counts as none. react-query always sends `null`, but a hook that merges two
 * queries can send `undefined`, and a screen must not report a failed refresh for that.
 *
 * Which control to offer is not decided here. Hand the error to the describer: its `recover` comes
 * from the same rule the query client retries by, so the button and the retry cannot disagree.
 */
export type QueryView<T, E = unknown> =
  | { readonly state: "waiting" }
  | { readonly state: "failed"; readonly error: E }
  | { readonly state: "ready"; readonly data: T; readonly refreshError: E | null };

export function queryView<T, E>(query: {
  readonly data: T | undefined;
  readonly error?: E | null;
}): QueryView<T, E> {
  const { data } = query;
  const error = query.error ?? null;
  if (data !== undefined) return { state: "ready", data, refreshError: error };
  if (error !== null) return { state: "failed", error };
  return { state: "waiting" };
}
