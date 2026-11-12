# @gusnips/locale

Where a language lives in a URL, how it crosses to another origin, which one a reader asked for,
and what day it is in a time zone. No dependencies, and nothing tied to a framework: your API
server, your browser entry and your prerender script all compile these same files.

```bash
bun add @gusnips/locale
```

```ts
import { createLocales } from "@gusnips/locale";

const { localePath } = createLocales(["en", "pt-BR"] as const, "en");

localePath("pt-BR", "/terms"); // → "/pt/terms"
```

## One list in, nine functions out

The list of languages and which one is the default are yours: they are your content plan, not
plumbing. Everything derived from them is here.

```ts
export const SUPPORTED_LOCALES = ["en", "pt-BR", "es"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const { asLocale, localePath, splitLocalePath, localeUrl, localeQueryUrl } = createLocales(
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
);
```

Every function is typed on your list, so `localePath("fr", "/")` is a compile error.

|                                        |                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `localePath(locale, path)`             | `("pt-BR", "/terms")` → `/pt/terms`. The default locale is unprefixed.   |
| `splitLocalePath(pathname)`            | The inverse: `/pt/terms` → `{ locale: "pt-BR", path: "/terms" }`.        |
| `localePrefix(locale)`                 | `""`, `/pt`, `/es`: the prefix on its own.                               |
| `localeSegment(locale)`                | `""`, `pt`, `es`: the segment without the slash.                         |
| `asLocale(value)`                      | Narrows an untrusted string to one of yours, or `null`.                  |
| `matchLocale(tags)`                    | The first of a reader's languages you ship: `["pt-PT", "en"]` → `pt-BR`. |
| `localeFromAcceptLanguage(header)`     | The same, from an `Accept-Language` header.                              |
| `localeUrl(origin, locale, path)`      | A link to another origin that has per-language addresses.                |
| `localeQueryUrl(origin, locale, path)` | A link to one that does not.                                             |

## Why the default language has no prefix

`/terms` and `/pt/terms`, not `/en/terms` and `/pt/terms`. Asymmetric on purpose: every address
you have already published stays valid, and the bare root needs no redirect, which is the thing
a crawler handles worst, and it is what `x-default` points at, so it has to be a real page.

The reason any of this exists is that **one address serving three languages by sniffing the
browser cannot be indexed.** A crawler fetches an address once, and whatever language came back
is the only thing that address will ever mean, so the other two languages are unreachable however
well they are written. One address per language is the whole fix.

## Send a reader to their language before the page shows

A bare address like `/pricing` is the only one that can be wrong for a reader. `/pt/pricing`
names its language; `/pricing` just gets the default. So a Portuguese reader who lands on
`/pricing` should end up on `/pt/pricing`.

If your app's entry file does that redirect, it happens too late. The browser shows the English
page while your JavaScript downloads, then jumps to Portuguese. That is a blink of about a
second, on every first visit.

`localeGateScript` decides before the page shows:

```ts
// vite.config.ts
import { localeGateScript } from "@gusnips/locale";
import { prePaintScript } from "@gusnips/vite";

prePaintScript({
  name: "locale",
  source: localeGateScript({
    locales: ["en", "pt-BR", "es"],
    defaultLocale: "en",
    storageKey: "app.locale",
  }),
  position: "head-prepend",
});
```

It picks the language in this order:

1. A supported query choice, such as `?lang=en`. It wins even when storage is blocked.
2. The language saved under `storageKey`. A saved default keeps the bare address.
3. The browser's languages, in the reader's own order. `pt-PT` and `pt` both find `pt-BR`.
4. Nothing matched: the reader stays where they are.

The query key defaults to `lang`. Set `queryParam` to match a custom key in `createLocales`.

It never moves a reader off an address that already names a language, and it keeps the query and
the `#fragment`. A crawler that runs no scripts stays on the default page.

Put the choice in the language link, including the default. That lets a new tab carry it without
relying on the original page's click handler:

```tsx
<a
  href={localeQueryUrl("", "en", localePath("en", path))}
  hrefLang="en"
  onClick={() => remember("en")}
  onAuxClick={(event) => {
    if (event.button === 1) remember("en");
  }}
>
  English
</a>
```

`remember` saves the choice for future unmarked visits, inside a `try` because storage can be blocked.
The query makes the link work even for "Open in new tab", which fires no click handler.
`localeQueryUrl` replaces old language parameters and keeps the other values and the fragment.
Its native query serialization may normalize encoding, such as `%20` to `+`.

When storage is blocked, later links also need the query choice if their next load must keep it.
Keep canonical URLs and prerender paths on `localePath` and `localeUrl`, without the parameter.

Three options, for sites that need them:

- `base: "/docs"` when the pages live under a path.
- `exclude: ["/login", "/app"]` for app screens served beside the site. They are never
  redirected, and neither is anything under them.
- `signedInKey: /^sb-.+-auth-token$/` leaves signed-in readers alone. Their language comes from
  their account, not their browser.

Serve it as a file, which is what `prePaintScript` does. A `script-src 'self'` policy blocks an
inline script without any error, and the blink comes back. Then take the redirect out of your
entry file: the entry just renders the language the address names.

## Read the language a request asks for

```ts
localeFromAcceptLanguage("de-DE,de;q=0.9,pt-BR;q=0.8"); // → "pt-BR"
```

Use it for a first guess: a new account, or an e-mail to someone who never picked a language. A
language the reader chose always wins over it. It returns `null` when nothing matches, so the
fallback is yours to pick.

It reads every tag, ranked by `q`, and skips `q=0`, which means "not this one". Reading only the
first tag is the common bug: the reader above is German and also reads Portuguese, and gets your
default language instead, on the account, and in every e-mail after.

`matchLocale(tags)` does the same for a list you already have, like `navigator.languages`. Both
keep the redirect script's rule: go through the reader's languages in their order, and for each
one take an exact match first, then one with the same base language. So `["pt-PT", "en"]` gets
your `pt-BR`, because the reader put Portuguese first.

## A language does not survive a jump to another origin

This is the part that gets written last and is usually a bug first. If your site is on
`example.com` and your app is on `app.example.com`, those are two origins. `localStorage` is
per-origin, so the same key name in both is not the same storage: a reader who picks Portuguese
on your site and clicks "Sign in" arrives at the app in whatever their browser guesses. There is
nothing to detect, because nothing crossed.

The link is what crosses. Which form depends on the destination:

```ts
// The docs site has a page per language: put it in the path.
localeUrl("https://docs.example.com", "pt-BR", "/guides/limits");
// → https://docs.example.com/pt/guides/limits

// The app is signed-in and has one address per route: put it in a parameter.
localeQueryUrl("https://app.example.com", "pt-BR", "/register");
// → https://app.example.com/register?lang=pt-BR
```

On the receiving side, read that parameter **before** storage and the browser, and cache it on
arrival. It is the only one of the three the reader chose on purpose and just now. With
`@gusnips/react`:

```ts
import { LOCALE_QUERY_PARAM } from "@gusnips/locale";

i18nInitOptions({ queryKey: LOCALE_QUERY_PARAM, storageKey: "app.locale", ... });
```

One constant on both ends, so the writer and the reader cannot drift apart.

The parameter is sent for the default language too. That looks like a default leaking and is not:
a reader on an unprefixed address has that language as their resolved preference, and leaving the
parameter off would let the app re-sniff a browser that disagrees with what the reader is plainly
reading.

## What day it is, in a time zone

```ts
import { dayKey } from "@gusnips/locale/time";

dayKey(new Date(), "America/Sao_Paulo"); // → "2026-09-23"
```

A day only exists in a time zone. At 22:00 in São Paulo it is already the next day in UTC, so a
server that asks "what day is it" without naming a zone gets its own machine's answer. Every
function here takes the zone as an argument, and none of them reads the machine's.

A date with no time (a due date, a birthday) is a **day key**: the string `"2026-09-23"`, which
is what a Postgres `date` column holds. Keep it a string, and compare it as one:

```ts
const overdue = dayKey(new Date(), zone) > invoice.dueDay;
```

Don't turn it into a `Date` to compare. A `Date` needs an hour, and any hour you pick is wrong for
part of the day: pin it to noon, and the invoice shows overdue from noon on the day it is due.

|                                                   |                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `dayKey(at, zone)`                                | The day an instant falls on in a zone.                                                      |
| `wallClock(at, zone)`                             | The day, hour, minute, second and weekday there.                                            |
| `zonedInstant(day, "09:00", zone)`                | The instant a wall time names. A skipped time moves forward; a doubled one takes the first. |
| `startOfDay(day, zone)`                           | When a day begins: midnight, or 01:00 where the clocks skipped midnight.                    |
| `periodAt(at, zone)`                              | The day and month keys, and when each one ends, for a daily cap or a monthly quota.         |
| `addDays`, `addMonths`, `daysBetween`, `monthKey` | Arithmetic on day keys. `addMonths("2026-01-31", 1)` is `"2026-02-28"`.                     |
| `formatDayKey(day, locale)`                       | `("2026-09-23", "pt-BR")` → `23/09/2026`, on every machine.                                 |
| `parseDayKey(raw)`                                | A real date in `YYYY-MM-DD` form, or `null`. Check untrusted input with it.                 |
| `canonicalTimeZone(raw)`                          | A zone name the runtime can use, or `null`. Refuses a bare offset like `-03:00`.            |

Use `formatDayKey`, not `new Date(day).toLocaleDateString()`. That reads the key as midnight UTC
and prints it in the reader's zone, which is the day before for everyone west of UTC.

Which zone to use is your call (the customer's, your billing zone, or UTC), and nothing here
guesses. It uses only `Intl`, so it runs on a server, in a browser and in a Worker.

## What a language pays in

```ts
import { currencyForLocale, formatMoney, quoteCurrency } from "@gusnips/locale/money";

currencyForLocale("pt-BR"); // → "brl"
formatMoney(9_700, "brl", "pt-BR"); // → "R$ 97"
```

Portuguese pays in reais, Spanish in euros, every other language in dollars. It reads the language
and never the country, so `pt-BR`, `pt-br` and `pt` agree. Spanish pays in euros even in Latin
America: a reader there is one click from dollars in a currency picker, which beats guessing from
an address.

`quoteCurrency` is the rule for which currency one reader is quoted and charged in, in this order:

1. The currency their customer is **locked** to. Stripe bills one customer in one currency, so the
   first purchase fixes it, and nothing moves it after.
2. The one they **chose** in a picker, when you can sell it.
3. The one their **language** pays in, when you can sell it.
4. Your **fallback**.

```ts
quoteCurrency({
  locked: customer.billingCurrency, // null until they have bought
  chosen: request.query.currency, // untrusted: narrowed inside
  locale: user.locale, // from their account, never from the browser
  sellable: (currency) => priceIdFor(plan, currency) !== undefined,
  fallback: "usd",
});
```

`sellable` is what keeps a half-seeded currency from reaching a reader: a currency whose Stripe
prices do not all exist is not offered. The fallback has to be one you can always sell.

`formatMoney` drops the cents on a whole amount (`R$ 97`, not `R$ 97,00`), because a pricing page
that prints `,00` reads as an invoice. In a list where some prices have cents, pass `keepCents` to
every price in it, so the list reads one way:

```ts
const keepCents = prices.some((cents) => cents % 100 !== 0);
formatMoney(49_900, "brl", "pt-BR", { keepCents }); // → "R$ 499,00" beside "R$ 99,90"
```

The reader's own currency reads by its symbol. A foreign one reads by its code (`USD 19` to a pt-BR
reader), because a bare `$` is a dollar to one reader and a peso to another.

This file holds no price. Every amount is set by hand for its market, never converted, and that
table is your catalog.

`currencyLabel` is how a currency reads in a list: `BRL (R$)`, `USD ($)`, `EUR (€)`, the code
first because it is the part nobody misreads. It is the label of an option, and the picker itself
is yours, in whatever select the product already has:

```tsx
<select value={currency} onChange={(event) => setCurrency(event.target.value)}>
  {CURRENCIES.map((code) => (
    <option key={code} value={code}>
      {currencyLabel(code, locale)}
    </option>
  ))}
</select>
```

Once a customer has paid their currency is fixed, so `disabled` the select and say why in words
beside it. A control that disappears leaves a question with no answer.

## Two things it does not do

**It never detects a language on its own.** The redirect script reads the browser on a bare
address, and `matchLocale` answers when you hand it a list. Inside an app, detection is
`@gusnips/react`'s `i18nInitOptions`, which follows the same rule.

**It does not write `og:locale`.** That tag needs a territory your list does not carry (`en` is
not valid there; `en_US` is), and which territory to claim is a product decision.
`@gusnips/vite`'s `bakeHead` writes it for you during a prerender.

## License

MIT
