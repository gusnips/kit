/**
 * Where a language lives in an address, and how it crosses to another one.
 *
 * Six repos on this stack wrote this file. Four of its five functions are byte-identical in all
 * six, with the same regex, asymmetry and comments. The fifth differs only in a parameter name.
 * What is NOT in all six is the half that decides whether a reader keeps the language they picked:
 * one repo had {@link Locales.localeUrl} and {@link Locales.localeQueryUrl}, and three shipped the
 * bug their absence causes.
 *
 * Zero dependencies and its own package, on purpose. An API server reads `asLocale` at its edges.
 * Measured across six repos, that plus the locale list is ALL a server uses. A server depending on
 * a package named "react" is a smell even when it costs nothing at runtime. Nothing in this repo
 * depends on this one, so it is a leaf: no version of it can pin a sibling.
 */

import { runLocaleGate, type GateConfig } from "./gate.ts";

/** The parameter that hands a language across an origin. One spelling, everywhere.
 *
 *  Pass it to `i18nInitOptions({ queryKey: LOCALE_QUERY_PARAM })` as well, and the reader and the
 *  writer of the language agree by construction. They are the same idea named twice otherwise,
 *  and one repo needed a test asserting the two strings matched. That test only exists because there were two strings. */
export const LOCALE_QUERY_PARAM = "lang";

/** What {@link createLocales} returns: the address shape for one product's closed locale list. */
export interface Locales<L extends string> {
  /** Narrow an untrusted string from a column, header or query parameter to a locale we ship. */
  asLocale: (value: string | null | undefined) => L | null;
  /** The locale we ship that a reader's preference list asks for first: `["pt-PT", "en"]` → `pt-BR`. */
  matchLocale: (tags: readonly string[]) => L | null;
  /** The same, from an `Accept-Language` header, honouring `q` and skipping `q=0`. */
  localeFromAcceptLanguage: (header: string | null | undefined) => L | null;
  /** A locale's segment in a URL path: `""` for the default, `pt`, `es`. */
  localeSegment: (locale: L) => string;
  /** Where a locale's pages live: `""` for the default, `/pt`, `/es`. */
  localePrefix: (locale: L) => string;
  /** A route path in one locale: `("pt-BR", "/terms")` → `/pt/terms`. */
  localePath: (locale: L, path: string) => string;
  /** The inverse: which locale an address is for, and the route path under it. */
  splitLocalePath: (pathname: string) => { locale: L; path: string };
  /** A route on another of our origins that HAS per-locale addresses. */
  localeUrl: (origin: string, locale: L, path?: string) => string;
  /** Carry an explicit language in a URL. An empty origin produces a relative navigation href. */
  localeQueryUrl: (origin: string, locale: L, path?: string) => string;
}

/**
 * The address shape for one product's locales.
 *
 * The list and the default belong to the product. They are its content plan, not plumbing, the same
 * way an API's error codes are its own vocabulary. Everything derived from them is here.
 *
 * ```ts
 * export const SUPPORTED_LOCALES = ["en", "pt-BR", "es"] as const;
 * export type Locale = (typeof SUPPORTED_LOCALES)[number];
 * export const DEFAULT_LOCALE: Locale = "en";
 *
 * export const { localePath, splitLocalePath, localeUrl, localeQueryUrl, asLocale } =
 *   createLocales(SUPPORTED_LOCALES, DEFAULT_LOCALE);
 * ```
 *
 * The default does not have to be English and is not in every repo on this stack, which is why it
 * is an argument rather than a lookup for `"en"`.
 */
export function createLocales<const L extends readonly string[]>(
  locales: L,
  defaultLocale: L[number],
  options: { queryParam?: string } = {},
): Locales<L[number]> {
  type Locale = L[number];
  const queryParam = options.queryParam ?? LOCALE_QUERY_PARAM;

  const asLocale = (value: string | null | undefined): Locale | null =>
    locales.find((locale) => locale === value) ?? null;

  /**
   * Walk the reader's list in THEIR order, and for each tag take an exact match (any case), then a
   * locale with the same base subtag. So `["pt-PT", "en"]` is Portuguese: the reader put it first,
   * and our Portuguese is the one they would pick over English.
   *
   * i18next's own matcher answers English there. It takes the first EXACT match anywhere in the
   * list before it tries any base subtag, so an English tag lower down beats a Portuguese variant
   * we don't list by name. The locale gate and `i18nInitOptions` in `@gusnips/react` keep this same
   * rule — the gate inlined because it runs as a serialized script, react because this package is a
   * leaf nothing may depend on — so one reader lands on one language on every road. The gate's test
   * holds the two copies here to the same table.
   *
   * When two locales share a base (`pt-BR` and `pt-PT`), a bare `pt` takes the first one listed.
   */
  const matchLocale = (tags: readonly string[]): Locale | null => {
    for (const tag of tags) {
      const lower = tag.trim().toLowerCase();
      if (lower === "") continue;
      const base = lower.split("-")[0];
      const found =
        locales.find((locale) => locale.toLowerCase() === lower) ??
        locales.find((locale) => locale.split("-")[0]?.toLowerCase() === base);
      if (found !== undefined) return found;
    }
    return null;
  };

  /**
   * The language a request asks for, narrowed to one we ship: a first-sight hint for a new account
   * or a page with no stored choice, never a replacement for one the person made.
   *
   * Every tag counts, not just the first. Five servers read only the first, so
   * `de-DE,de;q=0.9,pt-BR;q=0.8` — a German speaker who also reads Portuguese — got the default
   * language saved on their account, and with it every e-mail after. Tags are ranked by `q`
   * (stable, so equal weights keep the order sent), and `q=0`, which means "not this one", is
   * dropped. Null when nothing matches, so the caller picks its own default.
   */
  const localeFromAcceptLanguage = (header: string | null | undefined): Locale | null => {
    if (header === null || header === undefined) return null;
    const ranked = header
      .split(",")
      .map((entry) => {
        const [tag = "", ...params] = entry.split(";");
        const weight = params
          .map((param) => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(param)?.[1])
          .find((value) => value !== undefined);
        return { tag: tag.trim(), q: weight === undefined ? 1 : Number(weight) };
      })
      .filter((entry) => entry.tag !== "" && entry.q > 0)
      .sort((a, b) => b.q - a.q);
    return matchLocale(ranked.map((entry) => entry.tag));
  };

  /**
   * The BASE subtag, lowercase: `pt`, `es`.
   *
   * The path segment and the `hreflang` tag are allowed to differ, and only one of them has to be
   * real BCP-47: `hreflang="pt-BR"` does, a path segment does not. So the tag keeps the region and
   * the address does not. A segment is something people type, paste, shorten and read aloud, and
   * `/pt` is where every reader expects Portuguese to be — the region was carrying information
   * only the tag has to carry. Lowercase because paths are case-sensitive by spec and on
   * Cloudflare Pages, and half the tools that touch a link lowercase it, so a cased segment is a
   * 404 only some readers ever see.
   *
   * One donor moved from `pt-br` to `pt` and shipped the 301s in the same commit. The pair ships
   * together, or the change is a hole in the index.
   *
   * ponytail: two variants of ONE base language collide here — `pt-BR` and `pt-PT` would both want
   * `/pt`. That is the wall to hit before rethinking this, and the upgrade path is a per-locale
   * segment map, which is exactly what the region form was.
   *
   * Empty for the default locale, which is what makes every shape below asymmetric.
   */
  const localeSegment = (locale: Locale): string =>
    locale === defaultLocale ? "" : locale.replace(/-.*$/, "").toLowerCase();

  /**
   * The default locale is UNPREFIXED and every other one carries its segment.
   *
   * Asymmetric on purpose: every address already published stays valid, and the bare root needs no
   * redirect — the one thing a crawler handles worst, and what `x-default` points at, so it has to
   * be a real page rather than a hop.
   *
   * Why any of this exists: ONE address serving three languages by sniffing `navigator` cannot be
   * indexed. A crawler fetches an address once, and whatever language it happened to answer with
   * is the only thing that address will ever mean — so two thirds of the copy is unreachable no
   * matter how well it is written. One address per language is the whole fix.
   */
  const localePrefix = (locale: Locale): string => {
    const segment = localeSegment(locale);
    return segment === "" ? "" : `/${segment}`;
  };

  /** The root stays a bare `/` in the default locale and `/pt` — no trailing slash — elsewhere. */
  const localePath = (locale: Locale, path: string): string => {
    const prefix = localePrefix(locale);
    if (path === "/") return prefix === "" ? "/" : prefix;
    return `${prefix}${path}`;
  };

  /**
   * Matched against the SEGMENT rather than the tag — comparing a pathname to the locale list by
   * string equality is how `/pt/` fails to match `pt-BR` and gets debugged at 2am. An unprefixed
   * or unrecognized path is the default locale's, so `/es-AR/terms` reads as a default-language
   * page called `/es-AR/terms` (a 404) rather than silently becoming Spanish.
   */
  const splitLocalePath = (pathname: string): { locale: Locale; path: string } => {
    const match = /^\/([^/]+)(\/.*)?$/.exec(pathname);
    const segment = match?.[1]?.toLowerCase();
    const found = locales.find(
      (locale) => locale !== defaultLocale && localeSegment(locale) === segment,
    );
    if (match && found !== undefined) return { locale: found, path: match[2] ?? "/" };
    return { locale: defaultLocale, path: pathname };
  };

  /**
   * A route on ANOTHER of our origins, in this reader's language.
   *
   * The language does not survive an origin hop by itself. A storefront, a docs site and a console
   * on three subdomains are three ORIGINS, so one `localStorage` key spelled identically in all
   * three is a shared NAME with no shared storage behind it: a reader who picked Portuguese on the
   * storefront follows a link and gets whatever their browser guesses. No detection order fixes
   * that, because there is nothing to detect. The address is the only thing that crosses.
   *
   * Three repos shipped that bug and one of them had already written the fix down as "this would
   * take a cookie" — it does not; it takes putting the language in the link.
   *
   * This form is for a destination that HAS per-locale addresses. The default locale's root comes
   * out as `origin + "/"` rather than the bare origin, which was worth one argument with itself:
   * the bare form looks tidier and the package first emitted it, but the caller passed `"/"` as
   * the path, so dropping it is the helper quietly discarding an argument. The two forms are the
   * same request to every browser and crawler, and `new URL(origin).href` normalizes to the
   * slash — so the tiebreak went to the version with no special case in it.
   */
  const localeUrl = (origin: string, locale: Locale, path = "/"): string =>
    `${origin}${localePath(locale, path)}`;

  /**
   * Carry the reader's choice in a URL, including the default language.
   *
   * An app without locale prefixes detects this parameter before storage and the browser. A public
   * site's language picker also needs it: the default language has no prefix, and a new tab or
   * blocked storage cannot carry the original page's click handler. An empty origin makes a
   * relative href; combine it with `localePath` for a localized public destination.
   *
   * Replace any previous language value rather than appending one. Otherwise a switch from an
   * address already carrying `?lang=es` leaves Spanish first and the new choice never arrives.
   * Other query values survive, although native URLSearchParams may normalize their encoding.
   * The path and fragment keep their spelling, and the fragment stays behind the query.
   *
   * Use `localePath` and `localeUrl` without this parameter for prerender paths and canonical URLs.
   */
  const localeQueryUrl = (origin: string, locale: Locale, path = ""): string => {
    const href = `${origin}${path}`;
    const hash = href.indexOf("#");
    const route = hash === -1 ? href : href.slice(0, hash);
    const fragment = hash === -1 ? "" : href.slice(hash);
    const question = route.indexOf("?");
    const address = question === -1 ? route : route.slice(0, question);
    const query = new URLSearchParams(question === -1 ? "" : route.slice(question + 1));
    query.set(queryParam, locale);
    return `${address}?${query}${fragment}`;
  };

  return {
    asLocale,
    matchLocale,
    localeFromAcceptLanguage,
    localeSegment,
    localePrefix,
    localePath,
    splitLocalePath,
    localeUrl,
    localeQueryUrl,
  };
}

/** What {@link localeGateScript} needs to know about one product's pages. */
export interface LocaleGateOptions<L extends readonly string[]> {
  /** The same list and default {@link createLocales} gets. */
  locales: L;
  defaultLocale: L[number];
  /** Where the reader's explicit choice is stored. The language picker writes the same key. */
  storageKey: string;
  /** Query parameter carrying an explicit choice. Defaults to LOCALE_QUERY_PARAM, like createLocales. */
  queryParam?: string;
  /** Where the pages are mounted when it is not the origin's root, e.g. `/docs`. */
  base?: string;
  /** Route paths (unprefixed, after `base`) that are never redirected, with everything under
   *  them: an app's own screens served beside a public site, e.g. `["/login", "/w"]`. */
  exclude?: readonly string[];
  /** A storage key that means someone is signed in, e.g. `/^sb-.+-auth-token$/`. Their language
   *  comes from their account, so the gate leaves them alone. It also leaves alone an address
   *  that carries a sign-in (`access_token=` in the fragment, `code=` in the query). */
  signedInKey?: RegExp;
}

/**
 * The one redirect off an unprefixed address, as a script that runs before first paint.
 *
 * The default locale is unprefixed, so `/pricing` is the only address that can be wrong for a
 * reader: every other one names its language. Every repo on this stack sent that reader to
 * `/pt/pricing` from `main.tsx`, "before the first render", yet still showed the English page for
 * about a second, because the render is not the paint. The prerendered file IS the English page,
 * the browser paints it while the bundle downloads, and only then does the entry run. Deciding in a
 * classic `<head>` script is what gets ahead of the paint: it runs before the body is parsed, and
 * the page it leaves is hidden, so nothing of it shows.
 *
 * A prefixed address wins. On a bare address, a supported query choice wins over storage and the
 * browser, so choosing the default works even with blocked storage or a context-menu new tab.
 * Otherwise a stored choice wins, then the browser's languages in the reader's own order, exact
 * tag before base subtag. Excluded routes and signed-in/auth callbacks stay untouched.
 *
 * Serve it as a FILE with `@gusnips/vite`'s `prePaintScript`, never inline, because a `script-src 'self'` policy silently blocks an inline script, and the blink comes back:
 *
 * ```ts
 * // vite.config.ts
 * prePaintScript({
 *   name: "locale",
 *   source: localeGateScript({ locales: SUPPORTED_LOCALES, defaultLocale: DEFAULT_LOCALE, storageKey: "app.locale" }),
 *   position: "head-prepend",
 * })
 * ```
 *
 * The entry then renders what the address names and needs no gate of its own.
 */
export function localeGateScript<const L extends readonly string[]>(
  options: LocaleGateOptions<L>,
): string {
  const { localeSegment } = createLocales(options.locales, options.defaultLocale);
  const config: GateConfig = {
    locales: options.locales,
    defaultLocale: options.defaultLocale,
    prefixed: options.locales
      .filter((locale) => locale !== options.defaultLocale)
      .map((locale) => [locale, localeSegment(locale)] as const),
    storageKey: options.storageKey,
    queryParam: options.queryParam ?? LOCALE_QUERY_PARAM,
    base: (options.base ?? "").replace(/\/+$/, ""),
    exclude: (options.exclude ?? []).map((path) =>
      path.length > 1 ? path.replace(/\/+$/, "") : path,
    ),
    // Without `g`/`y`: those make `test()` stateful, and the gate calls it once per stored key.
    signedIn: options.signedInKey
      ? {
          source: options.signedInKey.source,
          flags: options.signedInKey.flags.replace(/[gy]/g, ""),
        }
      : null,
  };
  return `(${runLocaleGate.toString()})(${JSON.stringify(config)}, globalThis);\n`;
}
