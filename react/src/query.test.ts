import {
  MutationObserver,
  onlineManager,
  QueryClient,
  QueryObserver,
  type QueryObserverResult,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-error.ts";
import { queryDefaults, queryView, retryDelayMs, shouldRetry } from "./query.ts";

const refusal = (status: number, code?: string) =>
  new ApiError(status, code ? { code, message: code } : null);

/** A refusal that named its own expiry, the way a `Retry-After` header does. */
const waited = (status: number, secs: number) =>
  new ApiError(status, null, { retryAfterSecs: secs });

/** A refusal whose body says, in so many words, that waiting will never clear it. */
const never = (status: number) =>
  new ApiError(status, { code: "LIMIT_REACHED", message: "", details: { retryAfterSecs: null } });

/** The same body with no such key: details, but no claim either way. */
const silent = (status: number) =>
  new ApiError(status, { code: "LIMIT_REACHED", message: "", details: { scope: "account" } });

// Invariant 8, and the reason this module exists: three donors wrote three retry rules and
// each was right about something the other two got wrong. Every case below is one of those.
describe("shouldRetry", () => {
  it("retries a request that never landed", () => {
    // Offline, DNS, a dropped connection. Nothing about it is an answer.
    expect(shouldRetry(new TypeError("Failed to fetch"))).toBe(true);
  });

  // The describer reads anything that is not an `ApiError` as a request that never landed and
  // offers "try again". A vendor's error carrying a `status` of its own must get the same answer
  // here, or the button and the retry disagree.
  it("reads only its own ApiError as an answer", () => {
    const vendor = Object.assign(new Error("Invalid login credentials"), { status: 400 });
    expect(shouldRetry(vendor)).toBe(true);
    // The first backoff is at most 1.5 s, so 5 s would be the vendor's wait read as the server's.
    expect(
      retryDelayMs(0, Object.assign(new Error("x"), { status: 429, retryAfterSecs: 5 })),
    ).toBeLessThan(5000);
  });

  it("retries 5xx", () => {
    expect(shouldRetry(refusal(500))).toBe(true);
    expect(shouldRetry(refusal(503))).toBe(true);
  });

  it("does not retry a 4xx that is an answer", () => {
    // A 402, a 403 and a 404 say exactly the same thing three times.
    for (const status of [400, 401, 402, 403, 404, 409, 422, 451]) {
      expect(shouldRetry(refusal(status))).toBe(false);
    }
  });

  // Only one donor allowed this through, and it is the one 4xx a second attempt genuinely fixes.
  it("retries 408", () => {
    expect(shouldRetry(refusal(408))).toBe(true);
  });

  it("retries a burst 429", () => {
    expect(shouldRetry(refusal(429, "RATE_LIMIT_EXCEEDED"))).toBe(true);
  });

  // The sharpest rule of the three, and only one donor had it. A spent monthly quota and an
  // empty balance both arrive as 429 or 402, and neither clears by waiting — retrying burns
  // another request against the limiter and cannot succeed. The status alone cannot tell them
  // apart from a burst limit, which is why the caller names the codes.
  it("does not retry a limit the code says is durable", () => {
    const durable = ["QUOTA_EXCEEDED", "PAYMENT_REQUIRED"];
    expect(shouldRetry(refusal(429, "QUOTA_EXCEEDED"), durable)).toBe(false);
    expect(shouldRetry(refusal(402, "PAYMENT_REQUIRED"), durable)).toBe(false);
    // …and the burst limit still retries, which is the distinction the whole rule is for.
    expect(shouldRetry(refusal(429, "RATE_LIMIT_EXCEEDED"), durable)).toBe(true);
  });

  // A durable code wins even over a 5xx: if the server says the limit does not clear by
  // waiting, its status code is not the more specific claim.
  it("lets a durable code override the status", () => {
    expect(shouldRetry(refusal(503, "QUOTA_EXCEEDED"), ["QUOTA_EXCEEDED"])).toBe(false);
  });

  // The same judgement with the server doing the naming. The server half of this fleet sends
  // `details.retryAfterSecs: null` on a refusal no amount of time clears — a cap that frees only
  // when somebody deletes something, a slot that frees when another job ends. Read as "nothing
  // said how long", which is how every version before this one read it, that 429 gets retried
  // against a limit that cannot move, and the app has to keep a `durableLimitCodes` entry for a
  // claim the answer already carries.
  it("does not retry a refusal whose body says waiting never helps", () => {
    expect(shouldRetry(never(429))).toBe(false);
    // And it outranks the status, exactly as a durable code does.
    expect(shouldRetry(never(503))).toBe(false);
  });

  // The distinction the rule above rests on: an absent key is silence, not a claim, and silence
  // has always meant "retry a transient failure". Only a key that is present and `null` is the
  // claim — which is why this reads `=== null` and not `in`.
  it("still retries when the body carries details but no stated wait", () => {
    expect(shouldRetry(silent(500))).toBe(true);
    expect(shouldRetry(silent(429))).toBe(true);
  });

  // A header wait and a body `null` contradict each other. The `null` is written by whoever
  // raised this particular refusal; the number can come from a limiter that attaches one to
  // every 429 it emits, so the hand-written claim is the more specific one.
  it("takes an explicit never over a stated wait", () => {
    const both = new ApiError(
      429,
      { code: "LIMIT_REACHED", message: "", details: { retryAfterSecs: null } },
      { retryAfterSecs: 2 },
    );
    expect(shouldRetry(both)).toBe(false);
  });

  // The second migration's rule. Its limiter answers `Retry-After: 60` on a per-minute window,
  // so retrying at 1s and 2s spends two more requests that cannot possibly succeed.
  it("does not retry a stated wait longer than we will hold", () => {
    expect(shouldRetry(waited(429, 60))).toBe(false);
    expect(shouldRetry(waited(429, 2))).toBe(true);
    // The boundary is inclusive: exactly the ceiling is still worth waiting out.
    expect(shouldRetry(waited(429, 10))).toBe(true);
    expect(shouldRetry(waited(429, 11))).toBe(false);
  });

  it("takes the ceiling from the caller", () => {
    expect(shouldRetry(waited(429, 60), [], 90)).toBe(true);
    expect(shouldRetry(waited(429, 3), [], 1)).toBe(false);
  });

  // A long wait is an answer whatever the status says — the same judgement `durableLimitCodes`
  // makes, except here the server named it and the app did not have to.
  it("lets a stated wait override a 5xx", () => {
    expect(shouldRetry(waited(503, 300))).toBe(false);
  });

  it("still retries when nothing said how long", () => {
    expect(shouldRetry(refusal(429))).toBe(true);
  });
});

describe("queryDefaults", () => {
  afterEach(() => onlineManager.setOnline(true));

  // React Query's own mode holds a write pressed offline and sends it by itself once the
  // connection is back, even after its screen is gone. With the default, it fails where the
  // person pressed it. Broken, the mutation pauses and this test times out.
  it("sends a write pressed offline at once instead of holding it for later", async () => {
    onlineManager.setOnline(false);
    const client = new QueryClient({ defaultOptions: queryDefaults() });
    const mutationFn = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));

    await expect(new MutationObserver(client, { mutationFn }).mutate()).rejects.toThrow(
      "Failed to fetch",
    );
    expect(mutationFn).toHaveBeenCalledTimes(1);
  });
});

describe("retryDelayMs", () => {
  // The middle of the jitter, so the numbers below are the backoff itself.
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("backs off exponentially when nothing said how long", () => {
    expect(retryDelayMs(0, refusal(500))).toBe(1000);
    expect(retryDelayMs(1, refusal(500))).toBe(2000);
    // …and caps, so a long-lived query does not schedule a retry for next week.
    expect(retryDelayMs(20, refusal(500))).toBe(30_000);
  });

  it("waits what the server asked for", () => {
    expect(retryDelayMs(0, waited(429, 5))).toBe(5000);
  });

  // `Retry-After: 0` is a server saying "immediately", which for a client that was just refused
  // is still too soon — the backoff is the floor.
  it("never goes below the backoff", () => {
    expect(retryDelayMs(1, waited(429, 0))).toBe(2000);
  });

  it("backs off for a failure that is not an API answer at all", () => {
    expect(retryDelayMs(0, new TypeError("Failed to fetch"))).toBe(1000);
  });
});

describe("queryView", () => {
  /**
   * One real query, taken through every state a screen meets, with `queryView` checked against
   * react-query's own flags at each step. A plain object would only check this file against
   * itself; the observer is what says the reading of `data` and `error` is react-query's.
   */
  it("agrees with react-query's own flags through a query's whole life", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let answer: () => number = () => {
      throw new Error("down");
    };
    const observer = new QueryObserver(client, {
      queryKey: ["numbers"],
      queryFn: async () => answer(),
      enabled: false,
    });
    // Subscribed, as a mounted `useQuery` is. An observer nobody listens to never hears the query
    // change, and reads the last result it computed.
    const unsubscribe = observer.subscribe(() => {});
    const now = () => {
      const result: QueryObserverResult<number, Error> = observer.getCurrentResult();
      const view = queryView(result);
      expect(view.state === "failed").toBe(result.isLoadingError);
      expect(view.state === "ready" && view.refreshError !== null).toBe(result.isRefetchError);
      return { result, view };
    };

    // Switched off until something upstream answers: pending, but not loading.
    const off = now();
    expect(off.result.isLoading).toBe(false);
    expect(off.view).toEqual({ state: "waiting" });

    await observer.refetch();
    expect(now().view.state).toBe("failed");

    // Retrying a failed first load goes back to pending, so the reader sees it working.
    answer = () => 2;
    const retry = observer.refetch();
    expect(now().view.state).toBe("waiting");
    await retry;
    expect(now().view).toEqual({ state: "ready", data: 2, refreshError: null });

    // The case this exists for: a refresh fails over data already on screen.
    answer = () => {
      throw new Error("blip");
    };
    await observer.refetch();
    const stale = now();
    expect(stale.result.isError).toBe(true);
    expect(stale.view).toMatchObject({ state: "ready", data: 2 });
    expect(stale.view.state === "ready" && stale.view.refreshError?.message).toBe("blip");

    answer = () => 3;
    await observer.refetch();
    expect(now().view).toEqual({ state: "ready", data: 3, refreshError: null });
    unsubscribe();
  });

  it("reads a missing error as none, not as a failed refresh", () => {
    // A hook that merges two queries can hand over `undefined`; react-query never does.
    expect(queryView({ data: 2, error: undefined })).toStrictEqual({
      state: "ready",
      data: 2,
      refreshError: null,
    });
    expect(queryView({ data: undefined })).toStrictEqual({ state: "waiting" });
  });

  it("treats null as an answer, not as waiting", () => {
    expect(queryView({ data: null, error: null })).toEqual({
      state: "ready",
      data: null,
      refreshError: null,
    });
  });
});
