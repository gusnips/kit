const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// Public dummy secrets from Cloudflare's testing guide, never real widget credentials.
const TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

export type TurnstileVerdict =
  | { ok: true }
  | { ok: false; reason: "refused" | "unavailable" | "not-configured" };

interface TurnstileVerifierCommon {
  /** Server-only secret. Unset in live mode returns not-configured, never a pass. */
  secret: string | undefined;
  /** Bounds the request and response body. Defaults to 8 seconds. */
  timeoutMs?: number;
  /** A fetch implementation for a local check. Never a browser-side verifier. */
  fetcher?: typeof fetch;
}

export type TurnstileVerifierOptions = TurnstileVerifierCommon &
  (
    | {
        mode?: "live";
        /** Exact hostnames owned by this app, not request headers or caller-supplied values. */
        hostnames: readonly string[];
        /** The form's server-owned action, matching the browser widget. */
        action: string;
      }
    | {
        /** Only Cloudflare's published dummy secrets. Select explicitly for local development. */
        mode: "test-key";
        hostnames?: never;
        action?: never;
      }
  );

export interface TurnstileInput {
  token: string | undefined;
  /** Only an address the server trusts, such as clientIpOf's result. */
  remoteIp?: string | null;
}

export type VerifyTurnstile = (input: TurnstileInput) => Promise<TurnstileVerdict>;

/**
 * Verify one human form's token with Cloudflare, checking its hostname and action as well as
 * success. Each token lasts five minutes and verifies once. Do not retry this call with the
 * same token, or verify here before handing it to GoTrue: GoTrue owns its own verification.
 *
 * A service failure is not a token refusal. Neither permits mail or paid work to run. Map the
 * result to your own error, preserve the form's input and ask the browser for a fresh token.
 * No token, secret, provider body or thrown fetch error is logged or returned.
 *
 * Explicit test-key mode accepts only Cloudflare's public dummy secrets. Their success answer
 * names example.com and omits action, so that mode cannot check form binding. Select it only
 * for an explicit loopback development origin, never as an automatic fallback for live config.
 */
export function createTurnstileVerifier(options: TurnstileVerifierOptions): VerifyTurnstile {
  const { secret, timeoutMs = 8_000, fetcher = fetch } = options;
  const key = secret?.trim();
  if (options.mode === "test-key") {
    if (!key || !TEST_SECRETS.has(key))
      throw new TypeError(
        "Turnstile test-key mode accepts only Cloudflare's published dummy secrets. Use live mode for a real widget.",
      );
  } else {
    if (!options.hostnames.length || options.hostnames.some((hostname) => !hostname.trim()))
      throw new TypeError(
        "Turnstile needs your app's exact hostnames. Set hostnames before serving requests.",
      );
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(options.action))
      throw new TypeError(
        "Turnstile needs an action of 1 to 32 letters, digits, underscores or hyphens.",
      );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError("Turnstile needs a timeoutMs above zero. Set a bounded request deadline.");
  const expected =
    options.mode === "test-key"
      ? null
      : { hostnames: new Set(options.hostnames), action: options.action };

  return async ({ token, remoteIp }) => {
    if (!key) return { ok: false, reason: "not-configured" };
    if (!token?.trim() || token.length > 2_048) return { ok: false, reason: "refused" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(SITEVERIFY_URL, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: key,
          response: token,
          ...(remoteIp ? { remoteip: remoteIp } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: "unavailable" };
      const answer: unknown = await response.json();
      if (typeof answer !== "object" || answer === null || !("success" in answer))
        return { ok: false, reason: "unavailable" };
      if (answer.success === false) {
        const codes: unknown = "error-codes" in answer ? answer["error-codes"] : [];
        if (
          !Array.isArray(codes) ||
          !codes.every((code): code is string => typeof code === "string")
        )
          return { ok: false, reason: "unavailable" };
        const serviceFailed = codes.some((code) =>
          [
            "internal-error",
            "invalid-input-secret",
            "missing-input-secret",
            "bad-request",
          ].includes(code),
        );
        return { ok: false, reason: serviceFailed ? "unavailable" : "refused" };
      }
      if (answer.success !== true) return { ok: false, reason: "unavailable" };
      if (!("hostname" in answer) || typeof answer.hostname !== "string")
        return { ok: false, reason: "unavailable" };
      // Dummy secrets return example.com and no action. They cannot prove a live form's binding.
      if (expected === null) return { ok: true };
      if (!("action" in answer) || typeof answer.action !== "string")
        return { ok: false, reason: "unavailable" };
      if (!expected.hostnames.has(answer.hostname) || answer.action !== expected.action)
        return { ok: false, reason: "refused" };
      return { ok: true };
    } catch {
      return { ok: false, reason: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  };
}
