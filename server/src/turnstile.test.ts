import { afterEach, describe, expect, it, vi } from "vitest";
import { createTurnstileVerifier, type TurnstileVerifierOptions } from "./turnstile.ts";

const options = { secret: "server-secret", hostnames: ["app.example.com"], action: "contact" };
const input = { token: "browser-token", remoteIp: "192.0.2.1" };
const passed = { success: true, hostname: "app.example.com", action: "contact" };

function verifier(answer: unknown, config: Partial<TurnstileVerifierOptions> = {}) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(answer));
  return { verify: createTurnstileVerifier({ ...options, fetcher, ...config }), fetcher };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createTurnstileVerifier", () => {
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
      vi.fn<typeof fetch>(async () => new Response("private provider body", { status: 503 })),
      vi.fn<typeof fetch>(async () => new Response("not JSON")),
      vi.fn<typeof fetch>(async () => {
        throw new Error(`do not expose ${options.secret} ${input.token}`);
      }),
    ]) {
      const verify = createTurnstileVerifier({ ...options, fetcher });
      await expect(verify(input)).resolves.toEqual({ ok: false, reason: "unavailable" });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("aborts a timed-out fetch, clears its timer and never retries the same token", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
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
    const fetcher = vi.fn<typeof fetch>(
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

  it("refuses an empty allowlist, an invalid action or an unbounded deadline at creation", () => {
    for (const config of [
      { hostnames: [] },
      { hostnames: [""] },
      { action: "" },
      { action: "a".repeat(33) },
      { timeoutMs: 0 },
      { timeoutMs: Infinity },
    ])
      expect(() => createTurnstileVerifier({ ...options, ...config })).toThrow(TypeError);
  });
});
