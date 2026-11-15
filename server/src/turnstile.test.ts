import { afterEach, describe, expect, it, vi } from "vitest";
import { createTurnstileVerifier, type TurnstileVerifierOptions } from "./turnstile.ts";

type Fetcher = NonNullable<TurnstileVerifierOptions["fetcher"]>;
const options = { secret: "server-secret", hostnames: ["app.example.com"], action: "contact" };
const input = { token: "browser-token", remoteIp: "192.0.2.1" };
const passed = { success: true, hostname: "app.example.com", action: "contact" };

function verifier(
  answer: unknown,
  config: Partial<Extract<TurnstileVerifierOptions, { mode?: "live" }>> = {},
) {
  const fetcher = vi.fn<Fetcher>(async () => Response.json(answer));
  return { verify: createTurnstileVerifier({ ...options, fetcher, ...config }), fetcher };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("createTurnstileVerifier", () => {
  it("accepts the official dummy success shape only in explicit test-key mode", async () => {
    // Cloudflare's documented dummy response has this hostname and no action or cdata.
    const dummy = {
      success: true,
      challenge_ts: "2026-11-15T00:00:00.000Z",
      hostname: "example.com",
      "error-codes": [],
    };
    const secret = "1x0000000000000000000000000000000AA";
    const fetcher = vi.fn<Fetcher>(async () => Response.json(dummy));
    const verify = createTurnstileVerifier({ mode: "test-key", secret, fetcher });
    await expect(verify(input)).resolves.toEqual({ ok: true });
    await expect(
      verifier(dummy, { secret, hostnames: ["example.com"] }).verify(input),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("never lets real or missing secrets use test-key mode", () => {
    const fetcher = vi.fn<Fetcher>();
    for (const secret of [options.secret, undefined, "", "a-real-widget-secret"])
      expect(() => createTurnstileVerifier({ mode: "test-key", secret, fetcher })).toThrow(
        "accepts only Cloudflare's published dummy secrets",
      );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("also accepts the published always-fail and already-spent test secrets without passing them", async () => {
    for (const [secret, code] of [
      ["2x0000000000000000000000000000000AA", "invalid-input-response"],
      ["3x0000000000000000000000000000000AA", "timeout-or-duplicate"],
    ]) {
      const fetcher = vi.fn<Fetcher>(async () =>
        Response.json({ success: false, "error-codes": [code] }),
      );
      const verify = createTurnstileVerifier({ mode: "test-key", secret, fetcher });
      await expect(verify(input)).resolves.toEqual({ ok: false, reason: "refused" });
    }
  });

  it("checks a token once, posting the secret only to Cloudflare", async () => {
    const { verify, fetcher } = verifier(passed);
    await expect(verify(input)).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(request).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(request?.body))).toEqual({
      secret: options.secret,
      response: input.token,
      remoteip: input.remoteIp,
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits an untrusted or absent remote address", async () => {
    const { verify, fetcher } = verifier(passed);
    await verify({ token: input.token, remoteIp: null });
    const [, request] = fetcher.mock.calls[0]!;
    expect(JSON.parse(String(request?.body))).not.toHaveProperty("remoteip");
  });

  it("reports missing configuration without any request or false pass", async () => {
    for (const secret of [undefined, "", "  "]) {
      const { verify, fetcher } = verifier(passed, { secret });
      await expect(verify(input)).resolves.toEqual({ ok: false, reason: "not-configured" });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("refuses absent, blank and oversized tokens without a request", async () => {
    const { verify, fetcher } = verifier(passed);
    for (const token of [undefined, "", " ", "x".repeat(2_049)])
      await expect(verify({ token })).resolves.toEqual({ ok: false, reason: "refused" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-string runtime tokens and checks length before trimming", async () => {
    const { verify, fetcher } = verifier(passed);
    for (const token of [null, 42, {}, { trim: () => "token" }]) {
      // @ts-expect-error JavaScript callers can bypass the declared input type.
      await expect(verify({ token })).resolves.toEqual({ ok: false, reason: "refused" });
    }
    const trim = vi.spyOn(String.prototype, "trim");
    const result = await verify({ token: " ".repeat(2_049) });
    const trimmed = trim.mock.calls.length;
    trim.mockRestore();
    expect(result).toEqual({ ok: false, reason: "refused" });
    expect(trimmed).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(verify(input)).resolves.toEqual({ ok: true });
  });

  it("compares exact server-owned hostnames and the form's action", async () => {
    for (const answer of [
      { ...passed, hostname: "app.example.com.evil.test" },
      { ...passed, hostname: "other.example.com" },
      { ...passed, action: "signup" },
    ])
      await expect(verifier(answer).verify(input)).resolves.toEqual({
        ok: false,
        reason: "refused",
      });
    await expect(
      verifier(
        { ...passed, hostname: "www.example.com" },
        { hostnames: ["www.example.com"] },
      ).verify(input),
    ).resolves.toEqual({ ok: true });
  });

  it("distinguishes a refused or consumed token from a service/configuration failure", async () => {
    for (const code of ["invalid-input-response", "timeout-or-duplicate"])
      await expect(
        verifier({ success: false, "error-codes": [code] }).verify(input),
      ).resolves.toEqual({
        ok: false,
        reason: "refused",
      });
    for (const code of [
      "internal-error",
      "missing-input-secret",
      "invalid-input-secret",
      "bad-request",
    ])
      await expect(
        verifier({ success: false, "error-codes": [code] }).verify(input),
      ).resolves.toEqual({
        ok: false,
        reason: "unavailable",
      });
  });

  it("fails closed on malformed provider results", async () => {
    for (const answer of [
      null,
      [],
      {},
      { success: "true" },
      { success: false, "error-codes": [42] },
      { success: true },
      { ...passed, hostname: 42 },
      { ...passed, action: null },
    ])
      await expect(verifier(answer).verify(input)).resolves.toEqual({
        ok: false,
        reason: "unavailable",
      });
  });

  it("does not return HTTP errors, response bodies or thrown secrets", async () => {
    for (const fetcher of [
      vi.fn<Fetcher>(async () => new Response("private provider body", { status: 503 })),
      vi.fn<Fetcher>(async () => new Response("not JSON")),
      vi.fn<Fetcher>(async () => {
        throw new Error(`do not expose ${options.secret} ${input.token}`);
      }),
    ]) {
      const verify = createTurnstileVerifier({ ...options, fetcher });
      await expect(verify(input)).resolves.toEqual({ ok: false, reason: "unavailable" });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("aborts HTTP errors and cancels their unread bodies without awaiting cleanup", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }), { status: 503 });
    const fetcher = vi.fn<Fetcher>(async () => response);
    expect(cancel).not.toHaveBeenCalled();
    const verify = createTurnstileVerifier({ ...options, fetcher });
    await expect(verify(input)).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("settles at the deadline when a plain callable fetcher ignores abort, then cancels its late body", async () => {
    vi.useFakeTimers();
    let complete: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<Fetcher>(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const result = createTurnstileVerifier({ ...options, fetcher, timeoutMs: 100 })(input);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    const cancel = vi.fn();
    if (!complete) throw new Error("Fetcher did not start");
    complete(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("settles at the deadline when reading a response body ignores abort", async () => {
    vi.useFakeTimers();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetcher = vi.fn<Fetcher>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(passed)));
            },
          }),
        ),
    );
    const result = createTurnstileVerifier({ ...options, fetcher, timeoutMs: 100 })(input);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    try {
      expect(settled).toBe(true);
      await expect(result).resolves.toEqual({ ok: false, reason: "unavailable" });
    } finally {
      body?.close();
      await Promise.resolve();
    }
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("aborts a timed-out fetch, clears its timer and never retries the same token", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<Fetcher>(
      (_url, request) =>
        new Promise((_resolve, reject) => {
          request?.signal?.addEventListener("abort", () => reject(new Error("deadline")), {
            once: true,
          });
        }),
    );
    const verify = createTurnstileVerifier({ ...options, fetcher, timeoutMs: 100 });
    const result = verify(input);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds reading the response body and clears a successful request's timer", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<Fetcher>(
      async (_url, request) =>
        new Response(
          new ReadableStream({
            start(controller) {
              request?.signal?.addEventListener(
                "abort",
                () => controller.error(new Error("deadline")),
                {
                  once: true,
                },
              );
            },
          }),
        ),
    );
    const result = createTurnstileVerifier({ ...options, fetcher, timeoutMs: 100 })(input);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(verifier(passed).verify(input)).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not coerce runtime action values into strings", () => {
    for (const action of [42, undefined, { toString: () => "contact" }]) {
      // @ts-expect-error JavaScript callers can bypass the declared config type.
      expect(() => createTurnstileVerifier({ ...options, action })).toThrow(TypeError);
    }
  });

  it("refuses an empty allowlist, an invalid action or an unbounded deadline at creation", () => {
    for (const config of [
      { hostnames: [] },
      { hostnames: [""] },
      { action: "" },
      { action: "a".repeat(33) },
      { timeoutMs: 0 },
      { timeoutMs: 0.5 },
      { timeoutMs: Infinity },
      { timeoutMs: 2_147_483_648 },
    ])
      expect(() => createTurnstileVerifier({ ...options, ...config })).toThrow(TypeError);
  });
});
