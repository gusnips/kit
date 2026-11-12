import { describe, expect, it } from "vitest";
import {
  asCurrency,
  currencyForLocale,
  currencyLabel,
  formatMoney,
  quoteCurrency,
  type Currency,
} from "./money.ts";

const sellsAll = () => true;
const sellsOnly =
  (...sold: Currency[]) =>
  (currency: Currency) =>
    sold.includes(currency);

describe("currencyForLocale", () => {
  it("pays Portuguese in reais, Spanish in euros and everything else in dollars", () => {
    expect(currencyForLocale("pt-BR")).toBe("brl");
    expect(currencyForLocale("es")).toBe("eur");
    expect(currencyForLocale("en")).toBe("usd");
    expect(currencyForLocale("de")).toBe("usd");
  });

  it("reads the language, so every spelling of a locale agrees", () => {
    expect(currencyForLocale("pt-br")).toBe("brl");
    expect(currencyForLocale("pt")).toBe("brl");
    expect(currencyForLocale("pt_BR")).toBe("brl");
    expect(currencyForLocale("es-MX")).toBe("eur");
  });

  it("does not mistake an object key for a language", () => {
    expect(currencyForLocale("constructor")).toBe("usd");
    expect(currencyForLocale("")).toBe("usd");
  });
});

describe("asCurrency", () => {
  it("narrows what Stripe or a column hands us, forgiving case", () => {
    expect(asCurrency("BRL")).toBe("brl");
    expect(asCurrency("eur")).toBe("eur");
  });

  it("refuses a currency we do not sell in", () => {
    expect(asCurrency("mxn")).toBeNull();
    expect(asCurrency("")).toBeNull();
    expect(asCurrency(null)).toBeNull();
    expect(asCurrency(undefined)).toBeNull();
  });
});

describe("quoteCurrency", () => {
  const base = { locked: null, locale: "pt-BR", sellable: sellsAll, fallback: "usd" } as const;

  it("a customer who has bought pays in that currency forever, whatever they pick", () => {
    expect(quoteCurrency({ ...base, locked: "usd", chosen: "eur" })).toBe("usd");
    expect(quoteCurrency({ ...base, locked: "brl", sellable: sellsOnly("usd") })).toBe("brl");
  });

  it("a reader's pick beats their language", () => {
    expect(quoteCurrency({ ...base, chosen: "usd" })).toBe("usd");
  });

  it("ignores a pick that is not a currency, or one this deployment cannot sell", () => {
    expect(quoteCurrency({ ...base, chosen: "mxn" })).toBe("brl");
    expect(quoteCurrency({ ...base, chosen: "eur", sellable: sellsOnly("usd", "brl") })).toBe(
      "brl",
    );
  });

  it("follows the language when nothing is picked", () => {
    expect(quoteCurrency(base)).toBe("brl");
    expect(quoteCurrency({ ...base, locale: "es" })).toBe("eur");
  });

  it("falls back when the language's own currency was never seeded", () => {
    expect(quoteCurrency({ ...base, sellable: sellsOnly("usd") })).toBe("usd");
  });
});

describe("formatMoney", () => {
  const NBSP = " ";

  it("reads a reader's own currency by its symbol and drops whole cents", () => {
    expect(formatMoney(9_700, "brl", "pt-BR")).toBe(`R$${NBSP}97`);
    expect(formatMoney(1_900, "usd", "en")).toBe("$19");
    expect(formatMoney(1_700, "eur", "es")).toBe(`17${NBSP}€`);
  });

  it("keeps the cents when there are some", () => {
    expect(formatMoney(1_490, "brl", "pt-BR")).toBe(`R$${NBSP}14,90`);
    expect(formatMoney(1_490, "usd", "en")).toBe("$14.90");
  });

  it("prints whole cents when asked, so a mixed price list lines up", () => {
    expect(formatMoney(49_900, "brl", "pt-BR", { keepCents: true })).toBe(`R$${NBSP}499,00`);
    expect(formatMoney(1_900, "usd", "en", { keepCents: true })).toBe("$19.00");
    expect(formatMoney(1_490, "brl", "pt-BR", { keepCents: true })).toBe(`R$${NBSP}14,90`);
  });

  it("reads a foreign currency by its ISO code, never a symbol the reader could mistake", () => {
    expect(formatMoney(1_900, "usd", "pt-BR")).toBe(`USD${NBSP}19`);
    expect(formatMoney(9_700, "brl", "en")).toBe(`BRL${NBSP}97`);
  });
});

describe("currencyLabel", () => {
  it("leads with the code and follows with the symbol", () => {
    expect(currencyLabel("brl", "pt-BR")).toBe("BRL (R$)");
    expect(currencyLabel("usd", "en")).toBe("USD ($)");
    expect(currencyLabel("eur", "es")).toBe("EUR (€)");
  });

  it("reads the same symbol whichever language the reader has", () => {
    expect(currencyLabel("brl", "en")).toBe("BRL (R$)");
    expect(currencyLabel("usd", "pt-BR")).toBe("USD ($)");
  });
});
