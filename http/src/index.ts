/**
 * The HTTP envelope an API and its clients agree on.
 *
 * Every route answers either `{data, meta?}` or `{error:{…}}`, so unwrapping and error-shaping
 * belong in one place rather than in every hook. This module is that place, and it is deliberately
 * types plus three tiny functions: the API server produces the envelope, the browser client
 * consumes it, and an agent reads it. A published SDK can compile it too, instead of hand-writing
 * its own copy of the envelope. It carries no framework and no platform for that reason (see
 * `scripts/check-purity.ts`).
 *
 * **The codes are yours, not ours.** Two donor repos had 30 codes and 16 codes respectively,
 * overlapping on nine; the list is an API's vocabulary and belongs to it. Everything here is
 * generic over that union, so a product declares its own codes once and gets the envelope,
 * the status map and the narrowing for free.
 */

/** Where a list route puts its counts. Identical in every donor, to the field. */
export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Success envelope. Every 2xx JSON body is exactly this shape.
 *
 * `M` is the meta a route may attach. It defaults to {@link PaginationMeta} because a list route is
 * the common case; a metered API passes its own union instead (one donor carries cache/credit
 * counters there, and its rule that a cache hit is free and visibly so is the kind of thing that
 * must stay in that product).
 */
export interface ApiSuccess<T, M = PaginationMeta> {
  data: T;
  meta?: M;
}

/**
 * Error envelope: the wire shape a server returns for a failed request.
 *
 * The four fields are not decoration, and every donor arrived at the same four:
 *
 * - `code` is what a client switches on. Machine-oriented and stable.
 * - `message` is English, for logs, `curl` output and agents. It is the fallback a client
 *   shows when it cannot do better, never the primary copy for a person.
 * - `messageKey` names the SENTENCE, so a client can localize or re-word a refusal without
 *   the server knowing any language. The server owns the condition; the client owns the prose.
 * - `params` fills that sentence's blanks, and `details` carries what makes a refusal
 *   ACTIONABLE, such as the `resetAt` on a 429 or the plan that lifts a 402. A refusal a caller cannot
 *   act on is a dead end, which is the thing the whole product rule exists to prevent.
 */
export interface ApiErrorBody<Code extends string = string> {
  error: {
    code: Code;
    /** English fallback for logs, curl output and agents. Not shown when `messageKey` resolves. */
    message: string;
    /** Stable key naming the sentence, for a client that localizes or brands its copy. */
    messageKey?: string;
    /** Interpolation values for `messageKey`. */
    params?: Record<string, string | number>;
    details?: unknown;
  };
}

/**
 * One rejected field. When a request fails validation, `details` is an array of these.
 *
 * Enough to fix the call and nothing about the schema: the field, the rule, and a range's
 * bound. Never the rejected value, the validator's English sentence or an enum's allowed values;
 * the server builds this from an allow-list, so a validator upgrade cannot add them. That covers
 * the caller's own key names too, so an `unrecognized_keys` issue names no keys.
 *
 * Four codebases defined this shape before it lived here, and two more dropped the bound, so no
 * client could say "at most 200" about a limit the API's own docs state.
 */
export interface ValidationIssue {
  /** The field that failed, as the caller spelled it: `["items", 0, "qty"]`. */
  path: (string | number)[];
  /** The rule that rejected it, such as `too_big`. */
  code: string;
  /** The numeric bound, when the rule has one. */
  maximum?: number;
  minimum?: number;
}

export type ApiResponse<T, Code extends string = string, M = PaginationMeta> =
  | ApiSuccess<T, M>
  | ApiErrorBody<Code>;

/** True when a parsed body is the error half of the envelope. */
export function isApiError<Code extends string>(body: unknown): body is ApiErrorBody<Code> {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as ApiErrorBody).error === "object" &&
    (body as ApiErrorBody).error !== null
  );
}

/**
 * Narrow a code off the wire against the product's own list.
 *
 * An unrecognized code means the SERVER IS NEWER than this client: a deploy landed ahead of the
 * bundle a tab is still running. That is not a parse failure and must not throw; `fallback` is the
 * honest read of "something failed and this build cannot classify it".
 */
export function asErrorCode<Code extends string>(
  codes: readonly Code[],
  value: string,
  fallback: Code,
): Code {
  return codes.find((c) => c === value) ?? fallback;
}

/**
 * A note on the code→status map, which is deliberately NOT a function here.
 *
 * Write it at the call site and let `satisfies` do the work:
 *
 * ```ts
 * export const ERROR_STATUS = {
 *   NOT_FOUND: 404,
 *   RATE_LIMIT_EXCEEDED: 429,
 * } as const satisfies Record<HttpErrorCode, number>;
 * ```
 *
 * That is one line, and it is the line that matters: adding a code to the union without giving it a
 * status becomes a build error rather than a route answering 500 for a refusal it knew how to
 * explain. A helper wrapping this would add a call and subtract nothing. Keep every such map
 * exhaustive. ProviderKit learned the same about its error→copy maps, where a widened union fell
 * through to a status code in every locale at once.
 */
