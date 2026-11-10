import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import brasilApiUnknown from "../fixtures/brasil-api-unknown.json";
import cnpjWsPetrobras from "../fixtures/cnpj-ws-petrobras.json";
import cnpjWsUnknown from "../fixtures/cnpj-ws-unknown.json";
import minhaReceitaPetrobras from "../fixtures/minha-receita-petrobras.json";
import minhaReceitaUnknown from "../fixtures/minha-receita-unknown.json";
import receitaWsBancoDoBrasil from "../fixtures/receita-ws-banco-do-brasil.json";
import receitaWsUnknown from "../fixtures/receita-ws-unknown.json";
import { CnpjNotFoundError, CnpjUnavailableError, lookupCnpj } from "./lookup.ts";
import { minhaReceita, registry } from "./providers.ts";
import type { CnpjProvider } from "./types.ts";

const PETROBRAS = "33000167000101";
const UNKNOWN = "99999998000147";

const MINHA_RECEITA = "https://minhareceita.org/";
const BRASIL_API = "https://brasilapi.com.br/";
const CNPJ_WS = "https://publica.cnpj.ws/";
const RECEITA_WS = "https://receitaws.com.br/";

type Answer = (init?: RequestInit) => Promise<Response>;

function reply(recording: { status: number; body: unknown }): Answer {
  return async () => new Response(JSON.stringify(recording.body), { status: recording.status });
}

function status(code: number): Answer {
  return async () => new Response("", { status: code });
}

/** Never answers, and rejects when its signal aborts, as a real fetch does. */
const hang: Answer = (init) =>
  new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason));
  });

const unexpected: Answer = async () => {
  throw new Error("not expected");
};

/** A fetch that answers each public provider as told. The addresses it was asked are in `.mock.calls`. */
function providers(answers: {
  minhaReceita?: Answer;
  brasilApi?: Answer;
  cnpjWs?: Answer;
  receitaWs?: Answer;
}) {
  const route: [string, Answer][] = [
    [MINHA_RECEITA, answers.minhaReceita ?? unexpected],
    [BRASIL_API, answers.brasilApi ?? unexpected],
    [CNPJ_WS, answers.cnpjWs ?? unexpected],
    [RECEITA_WS, answers.receitaWs ?? unexpected],
  ];
  return vi.fn<typeof fetch>((input, init) => {
    const match = route.find(([prefix]) => String(input).startsWith(prefix));
    return (match?.[1] ?? unexpected)(init);
  });
}

function hosts(fetch: ReturnType<typeof providers>): string[] {
  return fetch.mock.calls.map(([input]) => new URL(String(input)).host);
}

const ALL_UNKNOWN = {
  minhaReceita: reply(minhaReceitaUnknown),
  brasilApi: reply(brasilApiUnknown),
  cnpjWs: reply(cnpjWsUnknown),
  receitaWs: reply(receitaWsUnknown),
};

describe("lookupCnpj", () => {
  it("answers from the first provider that has the company, and asks no other", async () => {
    const fetch = providers({ minhaReceita: reply(minhaReceitaPetrobras) });
    const record = await lookupCnpj("33.000.167/0001-01", { fetch });
    expect(record.razao_social).toBe("PETROLEO BRASILEIRO S A PETROBRAS");
    expect(hosts(fetch)).toEqual(["minhareceita.org"]);
  });

  it("moves past a failure and a not found, in order, to the provider that has it", async () => {
    const fetch = providers({
      minhaReceita: status(503),
      brasilApi: reply(brasilApiUnknown),
      cnpjWs: reply(cnpjWsPetrobras),
    });
    const record = await lookupCnpj(PETROBRAS, { fetch });
    expect(record.email).toBe("cc-rfisc@petrobras.com.br");
    expect(hosts(fetch)).toEqual(["minhareceita.org", "brasilapi.com.br", "publica.cnpj.ws"]);
  });

  it("throws CnpjNotFoundError when every provider says it does not have the CNPJ", async () => {
    const fetch = providers(ALL_UNKNOWN);
    const error = await lookupCnpj(UNKNOWN, { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CnpjNotFoundError);
    expect(error).toMatchObject({ cnpj: UNKNOWN });
    expect(hosts(fetch)).toEqual([
      "minhareceita.org",
      "brasilapi.com.br",
      "publica.cnpj.ws",
      "receitaws.com.br",
    ]);
  });

  it("throws CnpjUnavailableError, never not found, when one provider failed", async () => {
    const fetch = providers({ ...ALL_UNKNOWN, receitaWs: status(429) });
    const error = await lookupCnpj(UNKNOWN, { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CnpjUnavailableError);
    expect(error).toHaveProperty(
      "message",
      `No CNPJ provider answered for ${UNKNOWN}. Minha Receita: not found. BrasilAPI: not found. ` +
        "cnpj.ws: not found. ReceitaWS: HTTP 429.",
    );
    expect(error).toHaveProperty("cause", [
      new Error("ReceitaWS: HTTP 429", { cause: new Error("HTTP 429") }),
    ]);
  });

  it("finds a CNPJ with letters typed in lowercase with its mask, at the last provider", async () => {
    const fetch = providers({
      minhaReceita: status(503),
      brasilApi: status(503),
      cnpjWs: status(429),
      receitaWs: reply(receitaWsBancoDoBrasil),
    });
    const record = await lookupCnpj("00.000.000/e08g-12", { fetch });
    expect(record).toMatchObject({ cnpj: "00000000E08G12", razao_social: "BANCO DO BRASIL SA" });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://minhareceita.org/00000000E08G12",
      "https://brasilapi.com.br/api/cnpj/v1/00000000E08G12",
      "https://publica.cnpj.ws/cnpj/00000000E08G12",
      "https://receitaws.com.br/v1/cnpj/00000000E08G12",
    ]);
  });

  // A wrapper that takes only a URL string must typecheck: `typeof fetch` refused it, and under Bun's
  // types it also asked for `fetch.preconnect`.
  it("takes any function that fetches a URL string", async () => {
    const urls: string[] = [];
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      urls.push(url);
      return reply(minhaReceitaPetrobras)(init);
    };
    await expect(lookupCnpj(PETROBRAS, { fetch })).resolves.toMatchObject({ cnpj: PETROBRAS });
    expect(urls).toEqual([`https://minhareceita.org/${PETROBRAS}`]);
  });

  it("asks in the order given, a registry first", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).startsWith("https://registry.example/")
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify(minhaReceitaPetrobras.body)),
    );
    await lookupCnpj(PETROBRAS, {
      fetch,
      providers: [registry({ url: "https://registry.example/cnpj", apiKey: "k" }), minhaReceita()],
    });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      `https://registry.example/cnpj/${PETROBRAS}`,
      `https://minhareceita.org/${PETROBRAS}`,
    ]);
  });

  it("keeps a CNPJ's letters, uppercased, and refuses an invalid one before any request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 404 }));
    const providers = [registry({ url: "https://registry.example/cnpj" })];
    await expect(lookupCnpj(" 12.abc.345/01de-35 ", { fetch, providers })).rejects.toThrow(
      CnpjNotFoundError,
    );
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://registry.example/cnpj/12ABC34501DE35");

    fetch.mockClear();
    for (const bad of ["33.000.167/0001-02", "3300016700010", "CNPJ 33.000.167/0001-01", ""])
      await expect(lookupCnpj(bad, { fetch, providers })).rejects.toThrow(RangeError);
    await expect(lookupCnpj(PETROBRAS, { fetch, providers: [] })).rejects.toThrow(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("lookupCnpj's clock, without AbortSignal.any and AbortSignal.timeout", () => {
  const { any, timeout } = AbortSignal;
  beforeEach(() => {
    Object.assign(AbortSignal, { any: undefined, timeout: undefined });
  });
  afterEach(() => {
    Object.assign(AbortSignal, { any, timeout });
    vi.useRealTimers();
  });

  it("asks the next provider when one does not answer in time, and says so", async () => {
    const fetch = providers({ minhaReceita: hang, brasilApi: reply(minhaReceitaPetrobras) });
    await expect(lookupCnpj(PETROBRAS, { fetch, timeoutMs: 20 })).resolves.toMatchObject({
      cnpj: PETROBRAS,
    });

    const slow = providers({ ...ALL_UNKNOWN, cnpjWs: hang });
    await expect(lookupCnpj(UNKNOWN, { fetch: slow, timeoutMs: 20 })).rejects.toThrow(
      "cnpj.ws: no answer in 20 ms",
    );
  });

  it("rejects with the caller's reason at once, and asks no other provider", async () => {
    const controller = new AbortController();
    const fetch = providers({ minhaReceita: hang });
    const lookup = lookupCnpj(PETROBRAS, { fetch, signal: controller.signal });
    controller.abort(new Error("left the page"));
    await expect(lookup).rejects.toThrow("left the page");
    expect(hosts(fetch)).toEqual(["minhareceita.org"]);
  });

  /** Rejects with what `fail` makes the moment `signal` aborts. */
  function failsOnAbort(signal: AbortSignal, fail: () => unknown): CnpjProvider {
    return {
      name: "synthetic",
      lookup: () =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(fail()));
        }),
    };
  }

  it("keeps a provider's own failure that lands with the abort, and asks no other provider", async () => {
    const controller = new AbortController();
    const broken = new Error("the registry went away");
    const next = vi.fn<CnpjProvider["lookup"]>(async () => null);
    const lookup = lookupCnpj(PETROBRAS, {
      providers: [failsOnAbort(controller.signal, () => broken), { name: "next", lookup: next }],
      signal: controller.signal,
    });
    controller.abort(new Error("left the page"));
    await expect(lookup).rejects.toBe(broken);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects with the caller's reason when the runtime ends the request with its own AbortError", async () => {
    const controller = new AbortController();
    const reason = new Error("left the page");
    const lookup = lookupCnpj(PETROBRAS, {
      providers: [
        failsOnAbort(
          controller.signal,
          () => new DOMException("The operation was aborted.", "AbortError"),
        ),
      ],
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(lookup).rejects.toBe(reason);
  });

  it("leaves no timer behind", async () => {
    vi.useFakeTimers();
    const fetch = providers({ ...ALL_UNKNOWN });
    await expect(lookupCnpj(UNKNOWN, { fetch })).rejects.toThrow(CnpjNotFoundError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
