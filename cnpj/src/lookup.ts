/**
 * Looks a company up by CNPJ: each provider in turn, until one has it.
 *
 * Two outcomes must never be confused. `CnpjNotFoundError` is an answer: every provider said it
 * does not have this CNPJ. `CnpjUnavailableError` is no answer: at least one provider failed, so
 * the company may well exist. A form that says "no such company" over a dropped connection or a
 * rate limit sends the reader to retype a CNPJ that was right.
 */
import { isValidCnpj, normalizeCnpj } from "@gusnips/br";
import { brasilApi, cnpjWs, minhaReceita, receitaWs } from "./providers.ts";
import type { CnpjProvider, CnpjRecord } from "./types.ts";

/** Every provider answered that it does not have the CNPJ. */
export class CnpjNotFoundError extends Error {
  override name = "CnpjNotFoundError";

  constructor(readonly cnpj: string) {
    super(`No provider has the CNPJ ${cnpj}.`);
  }
}

/** No provider found the company and at least one failed. `cause` holds one error per failure. */
export class CnpjUnavailableError extends Error {
  override name = "CnpjUnavailableError";
}

export interface LookupCnpjOptions {
  /**
   * Asked in this order. Minha Receita, BrasilAPI, cnpj.ws and ReceitaWS when left out: the last two
   * allow 3 lookups a minute, so they come after the two that set no number.
   */
  providers?: CnpjProvider[];
  /** How long each provider gets before the next one is asked. 8 seconds. */
  timeoutMs?: number;
  /**
   * Aborting it rejects with its reason at once and asks no other provider. A provider that fails
   * for another reason in that same moment rejects with its own error instead of the reason.
   */
  signal?: AbortSignal;
  /**
   * Called with a URL string and `{ signal, headers }`, so a wrapper needs no more than this.
   * `typeof fetch` would ask a Bun-typed caller for `fetch.preconnect` too.
   */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * The company's record from the first provider that has it. A provider that fails or says "not
 * found" sends the lookup to the next one.
 *
 * Throws `RangeError` before any request when `cnpj` is not a valid CNPJ, `CnpjNotFoundError` when
 * every provider said it does not have it, and `CnpjUnavailableError` otherwise. Letters are kept:
 * `12.abc.345/01de-35` is asked for as `12ABC34501DE35`.
 */
export async function lookupCnpj(
  cnpj: string,
  options: LookupCnpjOptions = {},
): Promise<CnpjRecord> {
  // The 14 characters every provider is asked for, once the shape and the check digits hold.
  const key = normalizeCnpj(cnpj);
  if (key === null || !isValidCnpj(key)) {
    throw new RangeError(`Not a valid CNPJ: ${JSON.stringify(cnpj)}`);
  }
  const {
    providers = [minhaReceita(), brasilApi(), cnpjWs(), receitaWs()],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options;
  if (providers.length === 0) throw new RangeError("lookupCnpj needs at least one provider.");
  // Called bare, not as `options.fetch()`: browser fetch throws when `this` is not the window.
  const request = options.fetch ?? globalThis.fetch;
  const answers: string[] = [];
  const failures: Error[] = [];

  for (const provider of providers) {
    const attempt = providerSignal(timeoutMs, signal);
    try {
      const record = await provider.lookup(key, { signal: attempt.signal, fetch: request });
      if (record !== null) return record;
      answers.push(`${provider.name}: not found`);
    } catch (error) {
      // The caller aborted: the lookup ends with its reason and asks no other provider. A failure
      // that is not the abort's own, landing in the same moment, keeps its identity.
      if (signal?.aborted) throw endsAbort(error, signal) ? (signal.reason ?? error) : error;
      // Only the timer and the caller abort `attempt`, and the caller has not.
      const why = attempt.signal.aborted ? `no answer in ${timeoutMs} ms` : messageOf(error);
      const failure = new Error(`${provider.name}: ${why}`, { cause: error });
      failures.push(failure);
      answers.push(failure.message);
    } finally {
      attempt.release();
    }
  }

  if (failures.length === 0) throw new CnpjNotFoundError(key);
  throw new CnpjUnavailableError(`No CNPJ provider answered for ${key}. ${answers.join(". ")}.`, {
    cause: failures,
  });
}

/**
 * A signal that aborts after `timeoutMs` or as soon as the caller's `signal` does, and `release`,
 * which clears the timer and the listener so nothing outlives the request.
 *
 * Built by hand, as `@gusnips/br/lookup` does, because `AbortSignal.timeout` needs Safari 16 and
 * `AbortSignal.any` Safari 17.4, and React Native has neither.
 */
function providerSignal(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort);
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether `error` is how the abort itself ends a request: the signal's reason, which is what a
 * fetch rejects with, or an `AbortError` from a runtime that rejects with its own. `reason` is
 * missing before Safari 15.4, and there the aborted fetch's own error says the same thing.
 */
function endsAbort(error: unknown, signal: AbortSignal): boolean {
  return error === signal.reason || (error instanceof Error && error.name === "AbortError");
}
