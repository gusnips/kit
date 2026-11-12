/**
 * What a reader pays in, and how a price reads to them.
 *
 * A product that sells in more than one currency answers the same three questions, and each one is
 * easy to get slightly wrong in a way that charges somebody the wrong amount: which currency does
 * this language pay in, which currency does THIS customer pay in (Stripe bills one customer in one
 * currency, so the first purchase locks it), and how does an amount read next to a language's
 * own conventions. This file holds the rule for each, so they cannot drift apart across products.
 *
 * It does not hold a price. Every amount is set by hand for its market, never converted from
 * another, and that table is the product's catalog.
 *
 * Intl only, no dependency, same as `./time`.
 */

/** The currencies the family sells in, as Stripe writes them (lowercase ISO 4217). */
export const CURRENCIES = ["brl", "usd", "eur"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Languages that do not pay in dollars. Every other language does. */
const LANGUAGE_CURRENCY = new Map<string, Currency>([
  ["pt", "brl"],
  ["es", "eur"],
]);

/** A stored or Stripe-sent code narrowed to a currency we sell in, or null. Case is forgiven. */
export function asCurrency(code: string | null | undefined): Currency | null {
  const lower = code?.toLowerCase();
  return CURRENCIES.find((currency) => currency === lower) ?? null;
}

/**
 * The currency a language pays in: `pt` reais, `es` euros, anything else dollars.
 *
 * It reads the language, never the country, so `pt-BR`, `pt-br` and `pt` agree, and so do the
 * spellings a product's locale list uses. Spanish pays in euros even in Latin America. A reader
 * there is one click from dollars in a currency selector, and that is a better answer than a
 * guess from an IP address.
 */
export function currencyForLocale(locale: string): Currency {
  const language = locale.split(/[-_]/, 1)[0]?.toLowerCase() ?? "";
  return LANGUAGE_CURRENCY.get(language) ?? "usd";
}

export interface QuoteCurrencyInput {
  /** The currency this customer already pays in, once they have bought. Nothing moves it. */
  locked: Currency | null;
  /** What the reader picked in a currency selector. Untrusted: narrowed here. */
  chosen?: string | null;
  /** The reader's language, read from their account on the server, never sent by the browser. */
  locale: string;
  /** Whether this deployment can sell every item in a currency (its Stripe prices exist). */
  sellable: (currency: Currency) => boolean;
  /** Where everybody lands when nothing else can be sold. The caller guarantees it sells. */
  fallback: Currency;
}

/**
 * The currency a reader is quoted and charged in, in order: the one their customer is locked to,
 * the one they picked, the one their language pays in, then the fallback. A choice or a language
 * only counts while the deployment can sell it, so a currency whose prices were never seeded is
 * never offered. Half a currency is no currency.
 */
export function quoteCurrency({
  locked,
  chosen,
  locale,
  sellable,
  fallback,
}: QuoteCurrencyInput): Currency {
  if (locked) return locked;
  const picked = asCurrency(chosen);
  if (picked && sellable(picked)) return picked;
  const own = currencyForLocale(locale);
  return sellable(own) ? own : fallback;
}

/**
 * A currency as a reader finds it in a list: the code first, then the symbol in their language,
 * `BRL (R$)`, `USD ($)`, `EUR (€)`. The code leads because it is the part nobody misreads, and the
 * symbol follows because it is the part a reader scans for. Where the two are the same string the
 * code stands alone.
 *
 * This is the label of an `<option>`, or of the same entry in whatever select a product uses.
 * There is no picker here: every product already has a select of its own.
 */
export function currencyLabel(currency: Currency, locale: string): string {
  const code = currency.toUpperCase();
  const symbol =
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? code;
  return symbol === code ? code : `${code} (${symbol})`;
}

export interface FormatMoneyOptions {
  /**
   * Print the cents on a whole amount too: `R$ 499,00`. Set it on every price of a list in which
   * any price has cents, so `R$ 99,90` and `R$ 499,00` read as one list.
   */
  keepCents?: boolean;
}

/**
 * An amount in a reader's words: `R$ 97` in pt-BR, `$19` in en, `19 €` in es. A whole amount
 * drops its cents, because "R$ 97,00" on a pricing page reads as an invoice, unless `keepCents`
 * asks for them. The reader's own currency reads by its symbol. A foreign one reads by its ISO
 * code (`USD 19` to a pt-BR reader), never a symbol they could take for their own: a bare `$` is a
 * dollar to one reader and a peso to another.
 */
export function formatMoney(
  cents: number,
  currency: Currency,
  locale: string,
  { keepCents = false }: FormatMoneyOptions = {},
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: currencyForLocale(locale) === currency ? "symbol" : "code",
    minimumFractionDigits: cents % 100 === 0 && !keepCents ? 0 : 2,
  }).format(cents / 100);
}
