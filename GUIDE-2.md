# Build an app with the @gusnips packages, part 2

[Part 1](GUIDE.md) built `notes`: an API, a web app and sign-in. Part 2 adds what a product needs
next, one chapter at a time.

As in part 1, every snippet comes from a copy of the app that was built and run while this was
written, on Bun 1.4.2. Part 2 starts from part 1's repo, with the catalog moved up to
`@gusnips/http` `^0.1.4`, `@gusnips/react` `^0.9.17`, `@gusnips/server` `^0.8.19` and
`@gusnips/vite` `^0.8.26`. Move `@gusnips/react` and `@gusnips/vite` in the same commit:
[part 1 shows why](GUIDE.md#set-up-the-repo).

Part 2 covers:

1. [Pages a search engine can read](#pages-a-search-engine-can-read)
2. [More than one language](#more-than-one-language)
3. [Redis and background jobs](#redis-and-background-jobs)
4. [Sending mail](#sending-mail)
5. [Webhooks, in and out](#webhooks-in-and-out)
6. [An OpenAPI reference](#an-openapi-reference)
7. [A public API](#a-public-api)

## Pages a search engine can read

The web app draws its pages with JavaScript. A search engine, or the app that shows a preview when
someone pastes your link, often runs none. It sees `<div id="root"></div>` and nothing else. So the
public site renders each page to its own HTML file when it builds.

The site is a new app, `apps/site`, beside the web app. Its Vite config is the web app's, on
another port:

```ts
// apps/site/vite.config.ts
import { webPreset } from "@gusnips/vite/preset";
import { defineConfig } from "vite";

export default defineConfig(webPreset({ root: import.meta.dirname, port: 5174 }));
```

It depends on `@gusnips/react`, `@gusnips/tokens`, `react`, `react-dom` and `react-router-dom`, and
builds with the same tools as the web app. Its `.env` holds the two addresses it links to:

```text
VITE_SITE_URL=https://example.com
VITE_APP_URL=https://app.example.com
```

### One list of pages

```ts
// apps/site/src/pages.ts
import type { PublicPage } from "@gusnips/vite";

// Every public page, in one list. The prerender writes a file for each, and the sitemap lists
// each, so a page cannot be in one and missing from the other.
export interface SitePage extends PublicPage {
  title: string;
  description: string;
}

export const PAGES: readonly SitePage[] = [
  {
    path: "/",
    title: "Notes: write it down, find it later",
    description: "Write a note in one line, and find it again on any device.",
    priority: 1,
    changeFrequency: "weekly",
  },
  {
    path: "/pricing",
    title: "Pricing · Notes",
    description: "Notes is free for 100 notes. Unlimited notes cost $4 a month.",
    priority: 0.8,
    changeFrequency: "monthly",
  },
];
```

`PublicPage` gives each page a `path`, and the `priority` and `changeFrequency` the sitemap needs.
The title and the description are yours to add.

### One app, two ways in

The pages are ordinary React routes. The pricing page loads on demand, with `lazy()`:

```tsx
// apps/site/src/App.tsx
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";

const PricingPage = lazy(() =>
  import("./pages/PricingPage.tsx").then((m) => ({ default: m.PricingPage })),
);

export function App() {
  return (
    <Layout>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
```

The build renders that `App` once for each address:

```tsx
// apps/site/src/entry-server.tsx
import type { PageRenderer } from "@gusnips/vite";
import { renderTree } from "@gusnips/vite/render";
import { StrictMode } from "react";
import { StaticRouter } from "react-router-dom";
import { App } from "./App.tsx";

// The same App as main.tsx, with a router that takes the address as an argument.
export const renderPage: PageRenderer = (route) =>
  renderTree(
    <StrictMode>
      <StaticRouter location={route}>
        <App />
      </StaticRouter>
    </StrictMode>,
  );
```

Name the export `renderPage`. The prerender script looks for that name.

**Render with `renderTree`, never `renderToString`.** `renderToString` does not wait for a `lazy()`
page. We tried it here, and `pricing.html` held React's error message where the page should be. A
browser never shows that, because the app draws the page again on load. A search engine reads it.
`renderTree` waits for every `lazy()` page, and the script below stops the build if a file holds
that error. [Rendering](vite/README.md#rendering).

In the browser, `main.tsx` takes over the page the file already holds:

```tsx
// apps/site/src/main.tsx
import { hydrateOrMount } from "@gusnips/react/hydrate";
import { StrictMode } from "react";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

hydrateOrMount(
  root,
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
  window.location.pathname,
);
```

**Hydrate only the page the file holds.** To hydrate is to keep the HTML on screen and attach the
app to it, instead of drawing it again. A host answers an address it has no file for with your
`404.html`, and that file holds the not-found page. Each file names the page it holds, so
`hydrateOrMount` hydrates when that name matches the address, and draws the page fresh when it does
not. In a browser, `/` and `/pricing` kept the elements the file delivered, with no errors in the
console. `/nope` got the 404 file, and the app drew it fresh.

### The prerender script

`index.html` has to carry every tag the script rewrites: the description, the canonical, and the
`og:title`, `og:description`, `og:url` and `og:image` tags. Then, after `vite build`:

```ts
// apps/site/scripts/prerender.ts
import path from "node:path";
import { SHELL_ROUTE } from "@gusnips/react/contract";
import {
  assertOgImages,
  assertRendered,
  bakeHead,
  loadRenderer,
  loadTemplate,
  pageFile,
  robotsTxt,
  siteOrigin,
  sitemapFor,
  writeDist,
} from "@gusnips/vite";
import { PAGES } from "../src/pages.ts";

const SITE = path.resolve(import.meta.dirname, "..");
const DIST = path.join(SITE, "dist");
const ORIGIN = siteOrigin(process.env.VITE_SITE_URL ?? "https://example.com");

const renderPage = await loadRenderer(path.join(SITE, "dist-ssr/entry-server.js"));
// Read it before the loop: dist/index.html is the template, and also where the home page goes.
const template = await loadTemplate(DIST);

for (const page of PAGES) {
  const html = bakeHead(template, {
    title: page.title,
    description: page.description,
    canonical: `${ORIGIN}${page.path}`,
    image: `${ORIGIN}/og.png`,
    body: { route: page.path, html: await renderPage(page.path) },
  });
  const file = pageFile(page.path);
  assertRendered(file, html, template);
  await writeDist(DIST, file, html);
}

// Served for every address that has no file. It claims no address of its own.
const notFound = bakeHead(template, {
  title: "Page not found · Notes",
  description: "There is no page at this address.",
  canonical: null,
  noindex: true,
  body: { route: SHELL_ROUTE, html: await renderPage("/404") },
});
assertRendered("404.html", notFound, template);
await writeDist(DIST, "404.html", notFound);

await writeDist(DIST, "sitemap.xml", sitemapFor(ORIGIN, PAGES));
await writeDist(DIST, "robots.txt", robotsTxt({ origin: ORIGIN, sitemaps: ["/sitemap.xml"] }));
await assertOgImages(DIST, ORIGIN);

console.log(`Prerendered ${PAGES.length} pages and 404.html`);
// Under Bun, the renderer keeps the process alive after the last file is written.
process.exit(0);
```

`bakeHead` writes one page's title, tags and body into the template. `pageFile("/pricing")` is
`pricing.html`, and the sitemap and `robots.txt` come from the same list of pages.

**End with `process.exit(0)`.** Under Bun, the renderer keeps the process running after the work
is done. Without that line, the script printed its last line and was still running 25 seconds
later, when we stopped it. In CI, that is a job that does all its work, then waits for its timeout.

**The 404 page claims no address.** `canonical: null` removes the canonical and `og:url`, and
`noindex` keeps the page out of search results. Leave `image` out too: the page then keeps the
share image from `index.html`, which is a real file.
[Baking a page](vite/README.md#baking-a-page).

**Every check stops the build.** `bakeHead` stops when `index.html` is missing a tag it has to set.
`assertRendered` stops on a page that rendered too little, a loading screen, or React's error.
`assertOgImages` runs last: it reads every file the build wrote, and stops on a share image that
is not in `dist/`.

**Give the loading text `role="status"`,** as `App.tsx` does. A screen reader then reads it out,
and `assertRendered` can tell a loading screen from a page. We rendered the pricing page stuck on
its loading text: with a plain `<p>`, the file passed every check. With `role="status"`, the build
stopped.

`assertRendered` also wants each page to be at least 500 bytes bigger than `index.html`. Our
pricing page, before it had a header and a footer, grew by 396 bytes and stopped the build. For a
page that is short on purpose, pass a smaller floor: `assertRendered(file, html, template,
{ minGrowth: 200 })`.

### Build it

The site's `build` script runs the three steps in order:

```json
"build": "vite build && vite build --ssr src/entry-server.tsx --outDir dist-ssr && bun scripts/prerender.ts",
```

Add `dist-ssr/**` to the build's `outputs` in `turbo.json`, beside `dist/**`. turbo restores only
the folders listed there, so without it a cached build brings back the pages and not the renderer
that wrote them.

Then run `bun run build` in `apps/site`. It prints `Prerendered 2 pages and 404.html`, and `dist/`
holds `index.html`, `pricing.html`, `404.html`, `sitemap.xml` and `robots.txt`:

```text
User-agent: *
Allow: /

Sitemap: https://example.com/sitemap.xml
```

**Every address in the sitemap must answer 200, not redirect.** That is why the page is
`pricing.html` and not `pricing/index.html`: a host like Cloudflare Pages serves the flat file at
`/pricing`, and would redirect `/pricing` to `/pricing/` for the folder. Hosts differ, so run
`curl -I` on one page after your first deploy. [Flat files](vite/README.md#flat-files).

Run the script a second time without `vite build`, and it stops: `dist/index.html` no longer
holds an empty `<div id="root"></div>`. That file is both the template and the home page, and the
first run turned it into the home page.
[Sitemap, robots, OG cards](vite/README.md#sitemap-robots-og-cards).

## More than one language

Each language gets its own addresses: `/pricing` in English, `/pt/pricing` in Portuguese. A search
engine reads each address once, so a page that changes language to match the browser is found in
one language only. [Why the default language has no prefix](locale/README.md#why-the-default-language-has-no-prefix).

### One list of languages

The site, the web app and the API all need the list, so it goes in `packages/shared`, which now
depends on `@gusnips/locale`:

```ts
// packages/shared/src/locale.ts
import { createLocales } from "@gusnips/locale";

// The languages Notes ships. The site, the web app and the API all read this one list.
export const SUPPORTED_LOCALES = ["en", "pt-BR"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

// Where a reader's choice is saved. The site and the web app are two origins, so each has its
// own storage under this name; the choice crosses between them in the link.
export const LOCALE_STORAGE_KEY = "notes.locale";
export { LOCALE_QUERY_PARAM } from "@gusnips/locale";

export const { asLocale, localePath, localePrefix, localeUrl, localeQueryUrl, splitLocalePath } =
  createLocales(SUPPORTED_LOCALES, DEFAULT_LOCALE);
```

`localePath("pt-BR", "/pricing")` is `/pt/pricing`. The default language has no prefix, so every
address from the last chapter still works. `@gusnips/locale` has no dependencies, so the API can
import this file too.

Add `i18next` and `react-i18next` to the site and the web app, and
`i18next-browser-languagedetector` to the web app.

### The site in two languages

The words move into one catalog per language, `apps/site/src/i18n/en.json` and `pt-BR.json`, and a
component reads them with `const { t } = useTranslation()` and `t("pricing.heading")`. A `.d.ts`
file types the keys:

```ts
// apps/site/src/i18next.d.ts
import "i18next";
import type en from "./i18n/en.json";

// Checks every key you pass to t against the English catalog, so a missing key does not compile.
declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
  }
}
```

A typo like `t("home.nope")` then stops the typecheck. It checks the English catalog only; the
translation check at the end of this chapter covers the others.

On the site, the address names the language, so nothing needs detecting:

```ts
// apps/site/src/i18n/index.ts
import { DEFAULT_LOCALE, type Locale } from "@notes/shared";
import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import ptBR from "./pt-BR.json";

const resources = { en: { translation: en }, "pt-BR": { translation: ptBR } };

// The address names the language, so there is nothing to detect. One instance per call, because
// the prerender renders every language in one process.
export function createI18n(locale: Locale) {
  const i18n = createInstance({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    resources,
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  void i18n.use(initReactI18next).init();
  return i18n;
}
```

The build renders each page once for each language. The renderer takes the language as its second
argument, and the router's `basename` puts `/pt` in front of every link:

```tsx
// apps/site/src/entry-server.tsx
import type { PageRenderer } from "@gusnips/vite";
import { renderTree } from "@gusnips/vite/render";
import { DEFAULT_LOCALE, type Locale, localePath, localePrefix } from "@notes/shared";
import { StrictMode } from "react";
import { I18nextProvider } from "react-i18next";
import { StaticRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { createI18n } from "./i18n/index.ts";

// The same App as main.tsx, with a router that takes the address as an argument, and the
// language as a second one.
export const renderPage: PageRenderer<Locale> = (route, locale = DEFAULT_LOCALE) =>
  renderTree(
    <StrictMode>
      <I18nextProvider i18n={createI18n(locale)}>
        <StaticRouter location={localePath(locale, route)} basename={localePrefix(locale) || "/"}>
          <App />
        </StaticRouter>
      </I18nextProvider>
    </StrictMode>,
  );
```

In the browser, `main.tsx` reads the language out of the address:

```tsx
// apps/site/src/main.tsx, after the root is found
// "/pt/pricing" is the pricing page in Portuguese. The file names "/pricing" as its page.
const { locale, path } = splitLocalePath(window.location.pathname);

hydrateOrMount(
  root,
  <StrictMode>
    <I18nextProvider i18n={createI18n(locale)}>
      <BrowserRouter basename={localePrefix(locale) || "/"}>
        <App />
      </BrowserRouter>
    </I18nextProvider>
  </StrictMode>,
  path,
);
```

**Hand `hydrateOrMount` the page, not the address.** The file for `/pt/pricing` names `/pricing`
as its page, because the language lives in the `basename`. Pass `window.location.pathname` here and
no Portuguese page would ever match, so each one would be drawn again from nothing. With `path`,
`/pt` and `/pt/pricing` kept the elements the file delivered, with no errors in the console.

### The prerender, once for each language

The list of pages now says where each page's words are, instead of holding them:

```ts
// apps/site/src/pages.ts, the list
export const PAGES: readonly SitePage[] = [
  { path: "/", copy: "home", priority: 1, changeFrequency: "weekly" },
  { path: "/pricing", copy: "pricing", priority: 0.8, changeFrequency: "monthly" },
];
```

The script loops over the languages, and over the pages inside that. It now also imports
`sitemapXml` and the `Alternate` type from `@gusnips/vite`, `SUPPORTED_LOCALES`, `DEFAULT_LOCALE`,
`localePath` and `localeUrl` from `@notes/shared`, and `createI18n` from `../src/i18n/index.ts`:

```ts
// apps/site/scripts/prerender.ts, after the template is read
// Every language's address for one page, plus x-default for a reader who matches none. Each
// page carries the whole list, its own address included.
function alternatesFor(page: string): Alternate[] {
  return [
    ...SUPPORTED_LOCALES.map((locale) => ({
      hreflang: locale,
      href: localeUrl(ORIGIN, locale, page),
    })),
    { hreflang: "x-default", href: localeUrl(ORIGIN, DEFAULT_LOCALE, page) },
  ];
}

for (const locale of SUPPORTED_LOCALES) {
  const { t } = createI18n(locale);

  for (const page of PAGES) {
    const html = bakeHead(template, {
      title: t(`${page.copy}.title`),
      description: t(`${page.copy}.description`),
      canonical: localeUrl(ORIGIN, locale, page.path),
      image: `${ORIGIN}/og.png`,
      lang: locale,
      alternates: alternatesFor(page.path),
      body: { route: page.path, html: await renderPage(page.path, locale) },
    });
    // "/pt/pricing" is written to pt/pricing.html.
    const file = pageFile(localePath(locale, page.path));
    assertRendered(file, html, template, { lang: locale });
    await writeDist(DIST, file, html);
  }

  // One 404 page per language: a host serves the nearest one, so /pt/nope gets pt/404.html.
  const notFound = bakeHead(template, {
    title: t("notFound.title"),
    description: t("notFound.description"),
    canonical: null,
    noindex: true,
    lang: locale,
    body: { route: SHELL_ROUTE, html: await renderPage("/404", locale) },
  });
  const file = pageFile(localePath(locale, "/404"));
  assertRendered(file, notFound, template, { lang: locale });
  await writeDist(DIST, file, notFound);
}

const sitemap = sitemapXml(
  SUPPORTED_LOCALES.flatMap((locale) =>
    PAGES.map((page) => ({
      loc: localeUrl(ORIGIN, locale, page.path),
      changefreq: page.changeFrequency,
      priority: page.priority.toFixed(1),
      alternates: alternatesFor(page.path),
    })),
  ),
);
await writeDist(DIST, "sitemap.xml", sitemap);
```

`sitemapFor` from the last chapter knows one language. With two, you build the entries yourself and
hand them to `sitemapXml`. It takes `priority` as text, so `toFixed(1)` turns `1` into `"1.0"`.

The build now writes `index.html`, `pricing.html` and `404.html` in English, and `pt.html`,
`pt/pricing.html` and `pt/404.html` in Portuguese.

**Every page lists every language, its own included.** A search engine ignores the whole set unless
each address in it points back at the others. `x-default` is the page for a reader whose language
you do not ship.

**`lang` sets `<html lang>` and `og:locale`.** `pt/pricing.html` says `lang="pt-BR"` and
`og:locale` `pt_BR`. Open Graph reads a missing `og:locale` as `en_US`, so a link preview would
treat your Portuguese page as English. `assertRendered(…, { lang })` stops the build when a file is
marked with another language: `pt/pricing.html is not marked as pt-BR`.
[Baking a page](vite/README.md#baking-a-page).

**Each language needs its own 404.** A host answers a missing address with the nearest
`404.html`, so `/pt/nope` gets `pt/404.html`. Served that way, it came back with status 404 and the
Portuguese page.

### Send a reader to their language before the page shows

A reader with a Portuguese browser who lands on `/pricing` should see `/pt/pricing`. A redirect in
`main.tsx` comes too late: the browser can show the English page before it runs that file. The gate
runs before the page shows:

```ts
// apps/site/vite.config.ts
import { localeGateScript } from "@gusnips/locale";
import { prePaintScript } from "@gusnips/vite";
import { webPreset } from "@gusnips/vite/preset";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES } from "@notes/shared";
import { defineConfig } from "vite";

// Sends a reader on a bare address to their language before the page paints.
const localeGate = prePaintScript({
  name: "locale",
  source: localeGateScript({
    locales: SUPPORTED_LOCALES,
    defaultLocale: DEFAULT_LOCALE,
    storageKey: LOCALE_STORAGE_KEY,
  }),
  position: "head-prepend",
});

export default defineConfig(
  webPreset({ root: import.meta.dirname, port: 5174, plugins: [localeGate] }),
);
```

`prePaintScript` writes the gate to its own file and puts a `<script>` for it first in `<head>`.
In a browser set to Portuguese, `/pricing` went to `/pt/pricing`, and the first frame on screen was
already in Portuguese. A browser set to `pt-PT` went there too, and one set to `en-US` stayed. With
the gate's file blocked, the Portuguese browser stayed on the English page.

The gate checks a saved choice before the browser's languages, so the language picker has to save
one:

```tsx
// apps/site/src/components/LanguagePicker.tsx
import { type Locale, LOCALE_STORAGE_KEY, localePath, SUPPORTED_LOCALES } from "@notes/shared";
import { useLocation } from "react-router-dom";

// Each language in its own words, so a reader finds theirs without reading the other one.
const NAMES: Record<Locale, string> = { en: "English", "pt-BR": "Português" };

// The language gate reads this before the browser's languages. Without it, the link to the
// English page (a bare address) would send a reader with a Portuguese browser back to /pt.
function remember(locale: Locale) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage can be blocked. The gate then goes by the browser's languages, as if no one chose.
  }
}

export function LanguagePicker({ current }: { current: Locale }) {
  const { pathname } = useLocation();
  return SUPPORTED_LOCALES.filter((locale) => locale !== current).map((locale) => (
    <a
      key={locale}
      href={localePath(locale, pathname)}
      hrefLang={locale}
      lang={locale}
      onClick={() => remember(locale)}
      // A middle click opens a new tab and fires no click event.
      onAuxClick={(event) => {
        if (event.button === 1) remember(locale);
      }}
    >
      {NAMES[locale]}
    </a>
  ));
}
```

**Save the choice on a middle click too.** A middle click opens the link in a new tab, and fires
`auxclick` but not `click`. In a Portuguese browser, a click on "English" and a middle click both
landed on `/pricing` and stayed there. With storage blocked, the same click went back to
`/pt/pricing`: the gate had nothing saved, so it went by the browser.
[Send a reader to their language](locale/README.md#send-a-reader-to-their-language-before-the-page-shows).

### Carry the language to the web app

The site and the web app are two origins, and each origin has its own `localStorage`. A choice
saved on the site is not there when the reader clicks "Sign in". So the link carries it, and the
language picker sits beside it:

```tsx
// apps/site/src/components/Layout.tsx
import { asLocale, DEFAULT_LOCALE, localeQueryUrl } from "@notes/shared";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { LanguagePicker } from "./LanguagePicker.tsx";

export function Layout({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const locale = asLocale(i18n.language) ?? DEFAULT_LOCALE;
  return (
    <>
      <header className="mx-auto flex max-w-2xl items-center gap-6 p-8">
        <Link className="font-semibold" to="/">
          Notes
        </Link>
        <nav className="flex gap-4">
          <Link to="/pricing">{t("nav.pricing")}</Link>
          {/* The app is another origin, so the language rides in the link. */}
          <a href={localeQueryUrl(import.meta.env.VITE_APP_URL, locale, "/sign-in")}>
            {t("nav.signIn")}
          </a>
          <LanguagePicker current={locale} />
        </nav>
      </header>
      <main className="mx-auto max-w-2xl px-8">{children}</main>
      <footer className="mx-auto max-w-2xl p-8 text-sm">{t("footer")}</footer>
    </>
  );
}
```

On `/pt`, that link is `https://app.example.com/sign-in?lang=pt-BR`. The web app reads it with
`i18nInitOptions`:

```ts
// apps/web/src/i18n/index.ts
import { i18nInitOptions } from "@gusnips/react";
import {
  DEFAULT_LOCALE,
  LOCALE_QUERY_PARAM,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
} from "@notes/shared";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ptBR from "./locales/pt-BR.json";

// Screen readers and the browser's translate button read <html lang>, not i18next.
i18n.on("languageChanged", (language) => {
  document.documentElement.lang = language;
});

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, "pt-BR": { translation: ptBR } },
    ...i18nInitOptions({
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: SUPPORTED_LOCALES,
      storageKey: LOCALE_STORAGE_KEY,
      // A link from the site ends in ?lang=pt-BR. It wins over storage and the browser.
      queryKey: LOCALE_QUERY_PARAM,
    }),
  });

export { i18n };
```

`main.tsx` imports it once, beside `index.css`, and the web app gets its own `i18next.d.ts` like the
site's. Tests need it too, so `vitest.config.ts` lists it in `setupFiles`.

**The parameter wins, then the saved choice, then the browser.** An English browser that opened
`/sign-in?lang=pt-BR` got the page in Portuguese, and `<html lang="pt-BR">`. It opened `/sign-in`
again without the parameter and stayed in Portuguese, because the detector saved the choice.
[A language does not survive a jump to another origin](locale/README.md#a-language-does-not-survive-a-jump-to-another-origin).

The error sentences from part 1 go through `t` too, so a failure reads in the reader's language:

```ts
// apps/web/src/lib/describeError.ts
import { createErrorDescriber, type ErrorArm } from "@gusnips/react";
import type { ErrorCode } from "@notes/shared";
import { i18n } from "../i18n/index.ts";

const codes: Partial<Record<ErrorCode, ErrorArm>> = {
  VALIDATION_ERROR: () => ({
    cause: i18n.t("errors.invalid"),
    fix: i18n.t("errors.invalidFix"),
  }),
};

// The describer reads its four sentences (errors.network, errors.networkHint, errors.unexpected
// and errors.retrySoon) through t, so they come out in the reader's language.
export const describeError = createErrorDescriber({
  t: (key) => i18n.t(key),
  copyPrefix: "errors.",
  messageKeyPrefix: "serverErrors.",
  knownMessageKeys: {},
  formatWait: (secs) =>
    new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" }).format(secs, "second"),
  codes,
});
```

Leave out one of those four keys and the typecheck fails, because the describer names the keys it
reads. [Never dead-end anyone](react/README.md#never-dead-end-anyone).

### Check the translations

The typecheck knows the English keys. This script checks the rest: a key one language lacks, a
`{{name}}` renamed in translation, a plural form a language needs.

```ts
// scripts/check-i18n.ts
import { readFile } from "node:fs/promises";
import { checkI18n, formatI18nReport, type I18nBundle } from "@gusnips/vite/i18n";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@notes/shared";

async function readCatalog(file: string) {
  return { translation: JSON.parse(await readFile(file, "utf8")) };
}

const web: I18nBundle = {
  name: "apps/web",
  locales: SUPPORTED_LOCALES,
  canonical: DEFAULT_LOCALE,
  load: (locale) => readCatalog(`apps/web/src/i18n/locales/${locale}.json`),
  code: ["apps/web/src/**/*.{ts,tsx}"],
};

const site: I18nBundle = {
  name: "apps/site",
  locales: SUPPORTED_LOCALES,
  canonical: DEFAULT_LOCALE,
  load: (locale) => readCatalog(`apps/site/src/i18n/${locale}.json`),
  code: ["apps/site/src/**/*.{ts,tsx}", "apps/site/scripts/*.ts"],
};

const report = await checkI18n([web, site]);
console.log(formatI18nReport(report));
process.exit(report.problems.some((problem) => problem.level === "error") ? 1 : 0);
```

It lives in the root `scripts/`, because it reads two apps. The root `package.json` gets
`@gusnips/vite` and `@notes/shared` as dev dependencies, the script
`"i18n:check": "bun scripts/check-i18n.ts"`, and `&& bun run i18n:check` at the end of `check`, so
`bun run check` runs it with everything else.

We deleted `signIn.submit` from the Portuguese catalog, and `bun run i18n:check` stopped:

```text
apps/web
  ✖ parity: pt-BR signIn.submit missing
  · 4 key(s) no code reaches, as far as a scan can tell
✖ i18n: 1 error(s)
```

Those 4 keys are the describer's four sentences. It reads them by prefix, which a scan cannot see,
so that line is a hint, not a failure. `code` also checks that every `t("key")` in the source is in
the English catalog. [Check your translations](vite/README.md#check-your-translations).

## Redis and background jobs

Some work takes longer than a reader should wait for. The API puts it on a queue and answers at
once, and a second app, the worker, does the work. The queue lives in Redis, and BullMQ runs it.

The example is an import. `POST /notes/import` takes up to 1,000 titles, and the worker writes them
as notes.

Add `"bullmq": "^5.81.5"` and `"ioredis": "^5.11.1"` to the catalog. This example runs on version 5
of each.

**Move the two together.** `bun add ioredis bullmq` installs version 6 of each: 6.0.0 and 6.3.9 when
we wrote this. `@gusnips/server` accepts either version since 0.8.21. A mix does not work. With
BullMQ 5 and ioredis 6, the typecheck stopped at this:

```text
Type 'Redis<"legacy">' is not assignable to type 'ConnectionOptions'.
```

BullMQ 5 brings its own ioredis 5, and its types refuse a version 6 connection.

The API and the worker each get `REDIS_URL` in their `.env`. On your machine, `redis-server`
starts one at `redis://127.0.0.1:6379`. The API's tests need one too: add
`REDIS_URL: "redis://127.0.0.1:1"` to the `env` in `apps/api/vitest.config.ts`. Nothing listens on
port 1, so no test reaches a Redis you are using.

### What the API and the worker share

The API adds a job and the worker reads it, so the queue's name and the job's shape live in
`packages/server`, a new package named `@notes/server`:

```ts
// packages/server/src/index.ts
// The queues the API fills and the worker empties. Both import the name and the data type from
// here, so a job the API adds is always a job the worker can read.
export const QUEUES = {
  imports: "imports",
  deadLetters: "dead-letters",
} as const;

// Notes to add for one user. The API has already checked every title, and `importId` is also the
// job's id.
export interface ImportJob {
  importId: string;
  userId: string;
  titles: string[];
}
```

### The API adds the job

The API depends on `@notes/server`, `bullmq` and `ioredis`, and opens one connection:

```ts
// apps/api/src/redis.ts
import { CAPPED_EXPONENTIAL, createQueue } from "@gusnips/server/bullmq";
import { createRedis } from "@gusnips/server/redis";
import { type ImportJob, QUEUES } from "@notes/server";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

export const redis = createRedis({
  url: env.redisUrl,
  onError: (error) => logger.error("[redis] connection error", { error }),
  // The API only adds jobs. With Redis down, fail the request after 3 tries instead of waiting.
  maxRetriesPerRequest: 3,
});

export const imports = createQueue<ImportJob>(QUEUES.imports, {
  connection: redis,
  onError: (error) => logger.error("[bullmq] queue error", { error }),
  defaultJobOptions: { attempts: 3, backoff: { type: CAPPED_EXPONENTIAL } },
});
```

**Give the API's connection a retry limit.** By default, `createRedis` waits for Redis with no
limit, because a worker needs that. In the API, that wait is a request that never answers. We
stopped Redis: without `maxRetriesPerRequest`, the import was still waiting when curl gave up at
30 seconds. With `maxRetriesPerRequest: 3`, it answered 503 in about a second.

The route:

```ts
// apps/api/src/app.ts, the new route
const NewImport = z
  .object({ titles: z.array(z.string().trim().min(1).max(200)).min(1).max(1_000) })
  .strict();

// Adds many notes at once. The worker writes them, so the request only waits for Redis.
app.post("/notes/import", async (c) => {
  const { titles } = NewImport.parse(await c.req.json().catch(() => null));
  const importId = crypto.randomUUID();
  try {
    // If Redis has been down since the API started, add() waits until it comes back, and then adds
    // the job. By then the reader has given up, and trying again would import the notes twice.
    if (redis.status !== "ready") throw new Error(`Redis is ${redis.status}`);
    await imports.add("import", { importId, userId: c.get("userId"), titles }, { jobId: importId });
  } catch (error) {
    logger.error("[bullmq] could not add the import", { error });
    throw errors.unavailable("Imports are paused. Try again in a minute.");
  }
  return ok(c, { importId }, 202);
});
```

**Check the connection before you add a job.** If Redis is down when the API starts, `add()`
waits for it, whatever the retry limit says. We started the API with Redis stopped, and the import
was still waiting at 30 seconds. When Redis came back, the job went on the queue anyway, for a
request that had already failed. With the check, the same request answered 503 in 17 ms, and the
first import after Redis came back went through.

**Answer 202, not 201.** The notes do not exist yet. The id in the answer names the import.

`/health` asks Redis too, with `pingRedis`, and the API closes its connection with `quitRedis`
before Postgres when it stops. With Redis stopped, `/health` answered 503 `Redis is not answering`.
[Redis](server/README.md#redis).

### A job can run twice

If the worker dies halfway through a job, BullMQ runs the job again. We killed the worker with
`kill -9` during an import, twice: the job ran again 61 seconds later the first time, and 35
seconds later the second. So a job must be safe to run twice.

The import writes a row naming itself, in the same transaction as the notes. The table is a new
migration in the API, which owns the database:

```sql
-- apps/api/migrations/002_imports.sql
-- One row for each import the worker has written. The worker adds it in the same transaction as
-- the notes, so a job that runs twice finds it and writes nothing.
CREATE TABLE app.imports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX imports_created_at_idx ON app.imports (created_at);
```

```ts
// apps/worker/src/importNotes.ts
import type { ImportJob } from "@notes/server";
import type { Job } from "bullmq";
import { pool } from "./db.ts";

// A job can run twice: if the worker dies before BullMQ hears the job finished, it runs again.
// So the notes and a row naming the import commit together. A second run finds the row and
// writes nothing.
export async function importNotes(job: Job<ImportJob>): Promise<{ added: number }> {
  const { importId, userId, titles } = job.data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const marked = await client.query(
      "INSERT INTO app.imports (id, user_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [importId, userId],
    );
    if (marked.rowCount === 0) {
      await client.query("ROLLBACK");
      return { added: 0 };
    }
    await client.query("INSERT INTO app.notes (user_id, title) SELECT $1, unnest($2::text[])", [
      userId,
      titles,
    ]);
    await client.query("COMMIT");
    return { added: titles.length };
  } catch (error) {
    // Report the first error. A failed ROLLBACK after it would only hide the cause.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
```

**Commit the work and a record of it together.** A second run finds the record and writes nothing.
We ran a finished import again: it returned `{ added: 0 }`, and the list of notes did not change.

### The worker

The worker is a new app, `apps/worker`. It copies `logger.ts`, `db.ts` and `env.ts` from the API,
with `DATABASE_URL` and `REDIS_URL` as its only variables. Its crash handlers pass
`rejections: "exit"` where the API survives one: a job that stopped halfway may have left bad
state behind.

```ts
// apps/worker/src/index.ts
import { drainWith } from "./crash-handlers.ts"; // the first import
import {
  createQueue,
  createWorker,
  type DeadLetter,
  retryStalledFailures,
  syncJobSchedulers,
  wireDeadLetter,
} from "@gusnips/server/bullmq";
import { createShutdown } from "@gusnips/server/node";
import { assertRedisReachable, createRedis, quitRedis } from "@gusnips/server/redis";
import { type ImportJob, QUEUES } from "@notes/server";
import { HARD_EXIT_MS } from "./budget.ts";
import { pool } from "./db.ts";
import { env } from "./env.ts";
import { importNotes } from "./importNotes.ts";
import { logger } from "./logger.ts";
import { pruneImports } from "./pruneImports.ts";

// Recurring jobs get a queue of their own: syncJobSchedulers removes every schedule on its
// queue that the table below does not name.
const MAINTENANCE = "maintenance";

const redis = createRedis({
  url: env.redisUrl,
  onError: (error) => logger.error("[redis] connection error", { error }),
});
const onError = (error: Error) => logger.error("[bullmq] connection error", { error });

// pm2 loads this file with require(), which cannot wait at the top of a file. So every await
// sits inside start().
async function start() {
  // A worker that cannot reach Redis looks exactly like one with no work. Stop at boot instead.
  await assertRedisReachable(redis, {
    url: env.redisUrl,
    hint: "Start Redis with `redis-server`, or fix REDIS_URL in apps/worker/.env.",
  });

  const imports = createQueue<ImportJob>(QUEUES.imports, { connection: redis, onError });
  const deadLetters = createQueue<DeadLetter>(QUEUES.deadLetters, { connection: redis, onError });
  const maintenance = createQueue(MAINTENANCE, { connection: redis, onError });

  const importer = createWorker<ImportJob>(QUEUES.imports, importNotes, {
    connection: redis,
    onError,
  });
  const flushDeadLetters = wireDeadLetter(importer, deadLetters, { onError });
  const workers = [
    importer,
    // Every job that failed for good ends up here. Log it, so a person can look.
    createWorker<DeadLetter>(
      QUEUES.deadLetters,
      async (job) => logger.error("a job failed for good", { ...job.data }),
      { connection: redis, onError },
    ),
    createWorker(MAINTENANCE, pruneImports, { connection: redis, onError }),
  ];

  drainWith(
    createShutdown(
      [
        // Stop taking jobs, and let the running ones finish.
        { name: "workers", run: () => Promise.all(workers.map((worker) => worker.close())) },
        { name: "dead letters", run: flushDeadLetters },
        { name: "redis", run: () => quitRedis(redis) },
        { name: "postgres", run: () => pool.end() },
      ],
      { hardExitMs: HARD_EXIT_MS, logger },
    ),
  );

  // An import a deploy cut off is safe to run again, because importNotes writes it once.
  const retried = await retryStalledFailures(imports);
  await syncJobSchedulers(maintenance, { "prune-imports": { pattern: "0 4 * * *", tz: "UTC" } });
  logger.info("worker started", { retried });
}

void start();
```

**Stop at boot when Redis is not there.** A worker that cannot reach Redis looks exactly like one
with nothing to do. With Redis stopped, the worker exited with code 1 after 6 seconds, and logged:

```text
Redis at 127.0.0.1:50149 did not answer PING within 5000 ms. It is down, or the URL is wrong. Start Redis with `redis-server`, or fix REDIS_URL in apps/worker/.env.
```

The last sentence is the `hint`, the part only you can write.

**Every `await` goes inside `start()`.** pm2 loads the file with `require()`, as
[part 1 explains](GUIDE.md#stopping-for-a-deploy).

**A job that fails for good gets logged.** `redis.ts` gives each import 3 tries, a few seconds
apart. `wireDeadLetter` puts a job that used them all on the `dead-letters` queue, and the worker
logs it. We added an import with a `null` title: it failed 3 times, and `a job failed for good` was
in the log 9 seconds after we added it.

**`retryStalledFailures` runs again the jobs a deploy cut off.** Call it only on a queue whose jobs
are safe to run twice, as imports are.

**Recurring jobs get a queue of their own.** `syncJobSchedulers` removes every schedule on its
queue that its list does not name. Leave out `tz` and the typecheck fails, because a cron pattern
with no time zone runs on the server's clock.
[Background jobs](server/README.md#background-jobs).

### Stopping the worker

The worker gets a pm2 file beside the API's:

```js
// infra/worker/ecosystem.config.cjs
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "notes-worker",
      cwd: path.join(__dirname, "../../apps/worker"),
      script: "src/index.ts",
      interpreter: "bun",
      kill_timeout: 30_000,
    },
  ],
};
```

```ts
// apps/worker/src/budget.ts
// How long a deploy waits. The longest job < HARD_EXIT_MS < pm2's kill_timeout.
// An import of 1,000 notes is one INSERT, so 25 seconds is room to spare.
export const HARD_EXIT_MS = 25_000;
```

`pm2 stop notes-worker` ran each step in order: `workers`, `dead letters`, `redis`, `postgres`.
`worker.close()` waits for the jobs running, so the longest job has to fit inside `HARD_EXIT_MS`.
An import of 1,000 notes took 118 ms here.

**The drain needs its time limit.** We stopped the worker while Redis was down, and
`worker.close()` did not return. The drain logged `shutdown did not finish in time` and exited
when `HARD_EXIT_MS` ran out, 25 seconds after the signal.

### Run it

Start Redis, then the worker from `apps/worker`:

```bash
redis-server
bun run dev
```

Then send an import, with a signed-in user's access token in `$TOKEN`:

```bash
curl -X POST http://localhost:3000/notes/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"titles":["Water the plants","Pay the rent","Call grandma"]}'
```

The API answers 202 with `{"data":{"importId":"…"}}`, and the three notes are in the list a moment
later.

## Sending mail

`@gusnips/server/mail` sends mail over SMTP. Here the worker uses it to tell the reader an import
is done, in the language they picked, with a link that stops these mails.

### A mail catcher on your machine

[Mailpit](https://mailpit.axllent.org) takes every mail sent to port 1025 and shows it at
`http://localhost:8025`. Nothing reaches a real inbox. Install it with your package manager, or
download it from its releases page, then run `mailpit`.

### The mailer

Add `"nodemailer": "^10.0.10"` to the catalog and to the worker. The worker's `.env` gets the mail
settings:

```text
# Where the unsubscribe link in a mail points: the API's public address.
API_URL=http://localhost:3000
# The API's value, so the API can check the links the worker signs.
UNSUBSCRIBE_SECRET=generate-with-openssl-rand-hex-32
# Leave SMTP_HOST empty to turn mail off. Mailpit takes mail on port 1025, with no login.
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_USER=
SMTP_PASS=
SMTP_FROM=Notes <no-reply@example.com>
```

```ts
// apps/worker/src/env.ts
import { validateEnv } from "@gusnips/server";

validateEnv(process.env, {
  required: ["DATABASE_URL", "REDIS_URL", "API_URL", "UNSUBSCRIBE_SECRET"],
  // Mail is off until SMTP_HOST is set. Once it is, a mail needs a From address.
  groups: { SMTP_HOST: ["SMTP_FROM"] },
  secrets: { UNSUBSCRIBE_SECRET: 32 },
  fix: "Copy apps/worker/.env.example to apps/worker/.env and fill it in.",
});

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  apiUrl: process.env.API_URL ?? "",
  unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET ?? "",
  smtpHost: process.env.SMTP_HOST,
  // `||`, not `??`: an empty `SMTP_PORT=` is "", and Number("") is 0.
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  smtpFrom: process.env.SMTP_FROM ?? "",
};
```

```ts
// apps/worker/src/mailer.ts
import { createMailer } from "@gusnips/server/mail";
import { env } from "./env.ts";

// With no SMTP_HOST, mail is off: `mailer.enabled` is false and the worker skips the send.
export const mailer = createMailer({
  host: env.smtpHost,
  port: env.smtpPort,
  user: env.smtpUser,
  pass: env.smtpPass,
  from: env.smtpFrom,
});
```

**Mail stays off until `SMTP_HOST` is set.** `mailer.enabled` is then false, and the worker skips
the send. A laptop with no mail catcher still runs imports.

**Check the From address at boot.** `createMailer` throws when it has a host and no From address.
The `groups` line in the env check catches that first, and names the key. With `SMTP_FROM` empty,
the worker stopped with:

```text
The environment has 1 problem:
- SMTP_HOST is set, so these must be set too: SMTP_FROM
Copy apps/worker/.env.example to apps/worker/.env and fill it in.
```

That works because `mailer.ts` imports `env.ts`, so the check runs before the mailer is built.

### A mail goes out once

A mail gets its own queue. The job carries what the mail needs, so `packages/server` grows:

```ts
// packages/server/src/index.ts
import type { Locale } from "@notes/shared";

// The queues the API fills and the worker empties. Both import the name and the data type from
// here, so a job the API adds is always a job the worker can read.
export const QUEUES = {
  imports: "imports",
  mail: "mail",
  deadLetters: "dead-letters",
} as const;

// Notes to add for one user. The API has already checked every title, and `importId` is also the
// job's id.
export interface ImportJob {
  importId: string;
  userId: string;
  // Where "your import is done" goes, and in which language. With no address, no mail.
  email: string | null;
  locale: Locale;
  titles: string[];
}

// One "your import is done" mail.
export interface ImportDoneMail {
  userId: string;
  email: string;
  locale: Locale;
  added: number;
}

// Part of the unsubscribe link's signature. The worker signs the link and the API checks it, and
// a token signed for any other purpose never passes.
export const UNSUBSCRIBE_PURPOSE = "unsubscribe:v1";
```

In the worker, `importNotes` gets the mail queue, and a second worker sends the mail:

```ts
// apps/worker/src/index.ts, inside start()
// One try, and never a second run: a mail sent twice is worse than one that failed.
const mail = createQueue<ImportDoneMail>(QUEUES.mail, {
  connection: redis,
  onError,
  defaultJobOptions: { attempts: 1 },
});
const deadLetters = createQueue<DeadLetter>(QUEUES.deadLetters, { connection: redis, onError });
const maintenance = createQueue(MAINTENANCE, { connection: redis, onError });

const importer = createWorker<ImportJob>(QUEUES.imports, (job) => importNotes(job, mail), {
  connection: redis,
  onError,
});
const sender = createWorker<ImportDoneMail>(QUEUES.mail, sendImportDone, {
  connection: redis,
  onError,
  maxStalledCount: 0,
});
const flushes = [importer, sender].map((worker) =>
  wireDeadLetter(worker, deadLetters, { onError }),
);
```

`importNotes` queues the mail at its very end:

```ts
// apps/worker/src/importNotes.ts, after the transaction
  // After the commit, so no mail announces notes that were never written. A second run returns
  // early, above, so the mail is queued once.
  if (email) await mail.add("import-done", { userId, email, locale, added: titles.length });
  return { added: titles.length };
}
```

**One try, and never a second run.** A mail sent twice is worse than one that failed. So the queue
gives each job `attempts: 1`, and the worker's `maxStalledCount: 0` fails a job whose worker died,
instead of running it again. Do not call `retryStalledFailures` on this queue. We stopped Mailpit
and ran an import: the mail job failed once, and the dead letter was in the log right away, with
`connect ECONNREFUSED`.

**Queue the mail after the commit.** No mail then announces notes that were never written. A
second run of the import returns before it reaches that line, so the mail is queued once.

In the drain, the `dead letters` step now flushes both workers:
`run: () => Promise.all(flushes.map((flush) => flush()))`.

### In the reader's language

The mail should be in the language the reader picked in the web app. The browser's own
`Accept-Language` header lists the browser's languages, which is a different thing. So the web
app's client sends the picked one on every request:

```ts
// apps/web/src/services/api.ts
import { createApiClient, returnPathFromLocation } from "@gusnips/react";
import { createSupabaseSessionAdapter } from "@gusnips/react/supabase";
import { i18n } from "../i18n/index.ts";
import { supabase } from "./supabase.ts";

export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL,
  session: createSupabaseSessionAdapter(supabase.auth),
  // The language the reader picked, which the browser's own header does not know. The API writes
  // mail in it.
  headers: () => ({ "Accept-Language": i18n.language }),
  onSessionDead: () => {
    const next = encodeURIComponent(returnPathFromLocation(window.location));
    window.location.replace(`/sign-in?next=${next}`);
  },
});
```

The API reads it in the import route with `localeFromAcceptLanguage`, which `packages/shared` now
exports from `createLocales`. `requireUser` also keeps the reader's address, with
`c.set("email", data.user.email ?? null)`, and `AppEnv` gets `email: string | null` beside
`userId`:

```ts
// apps/api/src/app.ts, in the import route
// For the mail. The web app sends the language the reader picked in this header.
const locale = localeFromAcceptLanguage(c.req.header("Accept-Language")) ?? DEFAULT_LOCALE;
const job = { importId, userId: c.get("userId"), email: c.get("email"), locale, titles };
```

And the worker writes the mail:

```ts
// apps/worker/src/sendImportDone.ts
import { signToken } from "@gusnips/server";
import { type ImportDoneMail, UNSUBSCRIBE_PURPOSE } from "@notes/server";
import type { Locale } from "@notes/shared";
import type { Job } from "bullmq";
import { pool } from "./db.ts";
import { env } from "./env.ts";
import { mailer } from "./mailer.ts";

const COPY: Record<Locale, (added: number) => { subject: string; body: string; stop: string }> = {
  en: (added) => ({
    subject: "Your import is done",
    body: added === 1 ? "We added 1 note to your list." : `We added ${added} notes to your list.`,
    stop: "Don't want these emails?",
  }),
  "pt-BR": (added) => ({
    subject: "Sua importação terminou",
    body:
      added === 1 ? "Adicionamos 1 nota à sua lista." : `Adicionamos ${added} notas à sua lista.`,
    stop: "Não quer mais receber esses e-mails?",
  }),
};

export async function sendImportDone(job: Job<ImportDoneMail>): Promise<{ sent: boolean }> {
  const { userId, email, locale, added } = job.data;
  if (!mailer.enabled) return { sent: false };

  const optedOut = await pool.query("SELECT 1 FROM app.mail_optouts WHERE user_id = $1", [userId]);
  if (optedOut.rowCount) return { sent: false };

  // No expiry: the link sits in old mail, and old mail is where people look for it.
  const token = await signToken({
    secret: env.unsubscribeSecret,
    purpose: UNSUBSCRIBE_PURPOSE,
    payload: userId,
  });
  const unsubscribeUrl = new URL("/unsubscribe", env.apiUrl);
  unsubscribeUrl.search = new URLSearchParams({ token, lang: locale }).toString();

  const copy = COPY[locale](added);
  await mailer.send({
    to: email,
    subject: copy.subject,
    text: `${copy.body}\n\n${copy.stop} ${unsubscribeUrl.href}`,
    // Also puts the link in the headers, where a mail app shows its own unsubscribe button.
    unsubscribeUrl: unsubscribeUrl.href,
  });
  return { sent: true };
}
```

**The picked language wins over the browser's.** From a browser set to `en-US`, a request with
`Accept-Language: pt-BR` came back 202, and the mail said `Sua importação terminou`. It needs no
CORS change, because a browser may always send that header. A request with no header, like a
plain `curl`, gets English.
[Read the language a request asks for](locale/README.md#read-the-language-a-request-asks-for).

### A link that stops these mails

The link in the mail opens a page on the API. It needs a table:

```sql
-- apps/api/migrations/003_mail_optouts.sql
-- One row for each person who asked for no more import emails. The unsubscribe link writes it,
-- and the worker reads it before every send.
CREATE TABLE app.mail_optouts (
  user_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

```ts
// apps/api/src/unsubscribe.ts
import { verifyToken } from "@gusnips/server";
import { UNSUBSCRIBE_PURPOSE } from "@notes/server";
import { asLocale, DEFAULT_LOCALE, type Locale } from "@notes/shared";
import { Hono } from "hono";
import { html } from "hono/html";
import { pool } from "./db.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

const COPY: Record<Locale, Record<"ask" | "button" | "done" | "broken" | "failed", string>> = {
  en: {
    ask: "Notes emails you when an import finishes.",
    button: "Stop these emails",
    done: "Done. Notes will not email you about imports again.",
    broken: "This link is broken. Open the latest import email from Notes and use the link there.",
    failed: "We could not save that just now. Try again in a minute.",
  },
  "pt-BR": {
    ask: "O Notes manda um e-mail quando uma importação termina.",
    button: "Parar de receber esses e-mails",
    done: "Pronto. O Notes não vai mais mandar e-mails sobre importações.",
    broken:
      "Este link está quebrado. Abra o último e-mail de importação do Notes e use o link dele.",
    failed: "Não conseguimos salvar agora. Tente de novo em um minuto.",
  },
};

// One sentence, and the button when there is something to press. A form with no action posts to
// the address it is on, so the token comes along.
function page(locale: Locale, text: string, button?: string) {
  return html`<!doctype html>
    <html lang="${locale}">
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Notes</title>
      <body>
        <p>${text}</p>
        ${button ? html`<form method="post"><button>${button}</button></form>` : ""}
      </body>
    </html>`;
}

export const unsubscribe = new Hono();

// Mail scanners open every link in a message, so a GET only shows the button.
unsubscribe.get("/", (c) => {
  const locale = asLocale(c.req.query("lang")) ?? DEFAULT_LOCALE;
  return c.html(page(locale, COPY[locale].ask, COPY[locale].button));
});

// The button, and the one-click POST a mail app sends with no cookie.
unsubscribe.post("/", async (c) => {
  const locale = asLocale(c.req.query("lang")) ?? DEFAULT_LOCALE;
  const copy = COPY[locale];
  const verdict = await verifyToken({
    secret: env.unsubscribeSecret,
    purpose: UNSUBSCRIBE_PURPOSE,
    token: c.req.query("token") ?? "",
  });
  if (!verdict.ok) return c.html(page(locale, copy.broken), 400);

  try {
    await pool.query(
      "INSERT INTO app.mail_optouts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [verdict.payload],
    );
  } catch (error) {
    // Our database failed, not the link. Calling the link broken would lose the unsubscribe.
    logger.error("[unsubscribe] could not save", { error });
    return c.html(page(locale, copy.failed, copy.button), 503);
  }
  return c.html(page(locale, copy.done));
});
```

The API mounts it with `app.route("/unsubscribe", unsubscribe)`, and gets `UNSUBSCRIBE_SECRET` in
its env check, with `secrets: { UNSUBSCRIBE_SECRET: 32 }`. Both apps hold the same value. Left as
the `.env.example` placeholder, the boot stops:
`UNSUBSCRIBE_SECRET looks like a placeholder from .env.example. Put the real secret there.`
The tests get a made-up one in `vitest.config.ts`, at least 32 characters long.

**A GET never unsubscribes anyone.** Mail scanners open every link in a message. The GET shows a
button, and the POST does the work. In a browser, the button worked under the API's
`default-src 'none'` security policy: a plain form needs no script and no style.

**The POST is also the one-click button.** `unsubscribeUrl` puts the link in the mail's
`List-Unsubscribe` header, and a mail app shows its own unsubscribe button for it. That button
sends a POST with `List-Unsubscribe=One-Click` and no cookie. We sent the same POST with curl, and
it answered 200. The second header a mail app needs, `List-Unsubscribe-Post`, is only written for
an `https` link, so the mail from your machine carries the first one only.

**A failure on your side is not a broken link.** With Postgres stopped, the POST answered 503 with
`We could not save that just now. Try again in a minute.`, and the button again. Only a token that
does not verify gets `This link is broken…`, with a 400. Calling a database outage a broken link
would lose the unsubscribe.

**The token never expires.** The link sits in old mail, and old mail is where people look for it.
So `signToken` gets no `ttlSecs`.

**Name the new public route in the guard test.** The test from part 1 failed on it:

```text
Error: 2 endpoint(s) answer with no guard running in front of them:
  GET /unsubscribe
  POST /unsubscribe
```

It passes once `isPublic` is `underAny(["/health", "/unsubscribe"])`.
[Sending mail](server/README.md#sending-mail),
[the unsubscribe headers](server/README.md#the-unsubscribe-headers).

### Run it

Run the new migration from `apps/api` with `bun run migrate`. Start `mailpit`, the API and the
worker, then send an import in Portuguese:

```bash
curl -X POST http://localhost:3000/notes/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -H "Accept-Language: pt-BR" \
  -d '{"titles":["Regar as plantas","Pagar o aluguel","Ligar para a vó"]}'
```

`http://localhost:8025` shows the mail:

```text
Sua importação terminou

Adicionamos 3 notas à sua lista.

Não quer mais receber esses e-mails? http://localhost:3000/unsubscribe?token=…&lang=pt-BR
```

## Webhooks, in and out

A webhook is a request one server sends another when something happens. Here, a user gives the API
an address, and the worker calls it each time one of their imports is done. At the end, a small
server receives one, the way the user's server would, and the way yours would when a service sends
you webhooks.

### Where they are kept

A new migration in the API adds two tables:

```sql
-- apps/api/migrations/004_webhooks.sql
-- The addresses a user asked us to call when an import is done, and each call we owe them.
CREATE TABLE app.webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  url text NOT NULL,
  -- Signs every delivery. The user sees it once, when they add the address.
  secret text NOT NULL,
  -- Turned off after too many deliveries in a row failed for good.
  enabled boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_user_id_idx ON app.webhook_endpoints (user_id);

-- One row for each event and each address. The import writes it in the same transaction as the
-- notes, so an event is never lost between the commit and the queue.
CREATE TABLE app.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL REFERENCES app.webhook_endpoints (id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  -- The exact text we send, so every attempt sends the same bytes.
  body text NOT NULL,
  -- pending, delivered or failed.
  status text NOT NULL DEFAULT 'pending',
  -- BullMQ does not count an attempt it was told to delay, so the count lives here.
  attempts integer NOT NULL DEFAULT 0,
  -- The last answer: an HTTP status, or why nothing came back.
  last_answer text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_event_id_idx ON app.webhook_deliveries (event_id);
```

### Adding an address

The API and the worker both check an address, so the rule for where a webhook may go lives in
`packages/server`. That package now depends on `@gusnips/server`, and `QUEUES` gets
`webhooks: "webhooks"`:

```ts
// packages/server/src/index.ts, added at the end
// One webhook to send: a row in app.webhook_deliveries, which is also the job's id.
export interface WebhookJob {
  deliveryId: string;
}

// Where a webhook may go: a public address, over https. `bun run dev` also lets it go to
// localhost, so you can receive one on your machine. Never on a server: there, localhost is your
// own API, Redis and Postgres.
export function webhookPolicy(toLocalhost: boolean): UrlPolicy {
  return toLocalhost ? { schemes: ["http:", "https:"], allowLoopback: true } : {};
}
```

Both apps read the switch in `env.ts`, with
`webhooksToLocalhost: process.env.WEBHOOKS_TO_LOCALHOST === "true"`, and both `dev` scripts turn it
on: `"dev": "WEBHOOKS_TO_LOCALHOST=true bun --watch src/index.ts"`.

**Only your machine sends webhooks to localhost.** A webhook is a request your server sends
wherever a user says, and on a server, localhost is your own API, Redis and Postgres. pm2 runs
`src/index.ts` and never the dev script, so the switch stays off there. Keep it out of `.env`.
Started without it, the API answered `http://localhost:4000/` with
`The address must start with https://.`

The routes:

```ts
// apps/api/src/webhooks.ts
import { newWebhookSecret, type UrlRefusalReason } from "@gusnips/server";
import { created, ok } from "@gusnips/server/hono";
import { resolvePublic } from "@gusnips/server/node";
import { webhookPolicy } from "@notes/server";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./app.ts";
import { pool } from "./db.ts";
import { env } from "./env.ts";
import { errors } from "./errors.ts";
import { logger } from "./logger.ts";

// Why an address was refused, in words the user can act on.
const REFUSED: Record<UrlRefusalReason, string> = {
  invalid: "That is not a web address.",
  scheme: "The address must start with https://.",
  credentials: "Take the user name and password out of the address.",
  port: "That port is not allowed.",
  "internal-name": "That name only works inside a private network. Use a public address.",
  "private-address": "That address is on a private network. Use a public address.",
  unresolvable: "No server has that name. Check the spelling.",
  "too-many-redirects": "That address redirects too many times.",
};

type Endpoint = { id: string; url: string; enabled: boolean; consecutiveFailures: number };

export const webhooks = new Hono<AppEnv>();

webhooks.get("/", async (c) => {
  const { rows } = await pool.query<Endpoint>(
    `SELECT id, url, enabled, consecutive_failures AS "consecutiveFailures"
     FROM app.webhook_endpoints WHERE user_id = $1 ORDER BY created_at`,
    [c.get("userId")],
  );
  return ok(c, rows);
});

const NewEndpoint = z.object({ url: z.string().trim().max(2_000) }).strict();

// An address to call when an import is done. The answer holds the signing secret, this once.
webhooks.post("/", async (c) => {
  const { url } = NewEndpoint.parse(await c.req.json().catch(() => null));
  // Check it now, so a bad address gets a 400 here instead of failing at every delivery. The
  // worker checks it again when it sends, because DNS can change in between.
  const checked = await resolvePublic(url, {
    signal: AbortSignal.timeout(5_000),
    policy: webhookPolicy(env.webhooksToLocalhost),
  }).catch((error: unknown) => {
    // Our DNS failed, not their address. Saying the name does not exist would be wrong.
    logger.error("[webhooks] could not look up an address", { error });
    throw errors.unavailable("We could not look up that address just now. Try again in a minute.");
  });
  if (!checked.ok) throw errors.invalid(REFUSED[checked.reason]);

  const { rows } = await pool.query<{ id: string; url: string; secret: string }>(
    `INSERT INTO app.webhook_endpoints (user_id, url, secret) VALUES ($1, $2, $3)
     RETURNING id, url, secret`,
    [c.get("userId"), checked.url.href, newWebhookSecret()],
  );
  return created(c, rows[0]);
});

webhooks.delete("/:id", async (c) => {
  const id = z.uuid().parse(c.req.param("id"));
  const { rowCount } = await pool.query(
    "DELETE FROM app.webhook_endpoints WHERE id = $1 AND user_id = $2",
    [id, c.get("userId")],
  );
  if (!rowCount) throw errors.notFound("Webhook");
  return c.body(null, 204);
});
```

`errors.ts` gets `invalid: (message: string) => appError("VALIDATION_ERROR", message)`, and the API
mounts the routes at the end of `app.ts`:

```ts
// apps/api/src/app.ts, at the end
// Where a user's own server hears that an import is done.
app.use("/webhooks/*", requireUser);
app.route("/webhooks", webhooks);
```

**Check the address when it is saved.** `resolvePublic` looks the name up, and refuses it if any
address it has is private. A bad address then gets a 400 right away, instead of failing at every
delivery. We tried these:

```text
https://169.254.169.254/latest/meta-data/  That address is on a private network. Use a public address.
https://localhost:4000/                    That name only works inside a private network. Use a public address.
https://no-such-host.invalid/              No server has that name. Check the spelling.
https://user:pw@example.com/               Take the user name and password out of the address.
not a url                                  That is not a web address.
```

The first is the cloud metadata service. `REFUSED` needs a sentence for every reason, so a reason
the kit adds later is a type error, not a blank message.

**The secret is shown once.** The answer to the POST carries it, and `GET /webhooks` never does. A
user who lost it deletes the address and adds it again.

**`"/webhooks/*"` also guards `/webhooks`.** With that line removed, the guard test from part 1
failed and named all three routes:

```text
Error: 3 endpoint(s) answer with no guard running in front of them:
  DELETE /webhooks/:id
  GET /webhooks
  POST /webhooks
```

[A URL somebody else gave you](server/README.md#a-url-somebody-else-gave-you).

### Sending one

The import writes a delivery row for each of the user's webhooks, in the same transaction as the
notes. Then it queues them:

```ts
// apps/worker/src/importNotes.ts
import type { ImportDoneMail, ImportJob, WebhookJob } from "@notes/server";
import type { Job, Queue } from "bullmq";
import { pool } from "./db.ts";

// A job can run twice: if the worker dies before BullMQ hears the job finished, it runs again.
// So the notes and a row naming the import commit together. A second run finds the row and
// writes nothing.
export async function importNotes(
  job: Job<ImportJob>,
  queues: { mail: Queue<ImportDoneMail>; webhooks: Queue<WebhookJob> },
): Promise<{ added: number }> {
  const { importId, userId, email, locale, titles } = job.data;
  // What the user's webhooks receive. The import's id names the event, so a receiver that gets it
  // twice can tell.
  const event = JSON.stringify({
    id: importId,
    type: "import.done",
    data: { added: titles.length },
  });
  let added = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const marked = await client.query(
      "INSERT INTO app.imports (id, user_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [importId, userId],
    );
    if (marked.rowCount === 1) {
      await client.query("INSERT INTO app.notes (user_id, title) SELECT $1, unnest($2::text[])", [
        userId,
        titles,
      ]);
      // One delivery for each of the user's webhooks, committed with the notes.
      await client.query(
        `INSERT INTO app.webhook_deliveries (endpoint_id, event_id, body)
         SELECT id, $2, $3 FROM app.webhook_endpoints WHERE user_id = $1 AND enabled`,
        [userId, importId, event],
      );
      added = titles.length;
    }
    await client.query("COMMIT");
  } catch (error) {
    // Report the first error. A failed ROLLBACK after it would only hide the cause.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // On a second run too, because the first may have stopped right before this line. A job's id is
  // its delivery's id, and BullMQ skips a job id it already has, so nothing is queued twice.
  const pending = await pool.query<{ id: string }>(
    "SELECT id FROM app.webhook_deliveries WHERE event_id = $1 AND status = 'pending'",
    [importId],
  );
  await queues.webhooks.addBulk(
    pending.rows.map(({ id }) => ({
      name: "deliver",
      data: { deliveryId: id },
      opts: { jobId: id },
    })),
  );

  // After the commit, so no mail announces notes that were never written. A second run added
  // nothing, so the mail is queued once.
  if (added > 0 && email) await queues.mail.add("import-done", { userId, email, locale, added });
  return { added };
}
```

**Write the delivery with the notes, and queue it on every run.** If the worker dies right after
the commit, the row is still there, and the import's second run queues it. A job's id is its
delivery's id, so a delivery already queued is not queued again. We added a finished import again
while its delivery was waiting to retry: the receiver got no extra request, and no note was written
twice.

The worker gets a queue for deliveries:

```ts
// apps/worker/src/index.ts, inside start()
// A retry here is for a failure on our side, such as Postgres down. The receiver's answers are
// counted on the delivery row.
const webhooks = createQueue<WebhookJob>(QUEUES.webhooks, {
  connection: redis,
  onError,
  defaultJobOptions: { attempts: 3, backoff: { type: CAPPED_EXPONENTIAL } },
});
```

And a worker that empties it:

```ts
// apps/worker/src/index.ts, inside start()
const deliverer = createWorker<WebhookJob>(QUEUES.webhooks, deliverWebhook, {
  connection: redis,
  onError,
  // A slow receiver holds its slot for up to 10 seconds. With one slot, everyone else waits.
  concurrency: 10,
});
```

The import's worker now calls `importNotes(job, { mail, webhooks })`. The deliverer joins `flushes`
and `workers`, and `retryStalledFailures` runs on its queue too. That is safe, because a receiver
skips an event it has seen.

Each delivery:

```ts
// apps/worker/src/deliverWebhook.ts
import { nextDeliveryStep, signWebhook } from "@gusnips/server";
import { fetchPublic } from "@gusnips/server/node";
import { type WebhookJob, webhookPolicy } from "@notes/server";
import { DelayedError, type Job } from "bullmq";
import { pool } from "./db.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

// After this many deliveries in a row fail for good, the address is turned off.
const TURN_OFF_AFTER = 10;

type Delivery = { endpointId: string; url: string; secret: string; body: string; attempts: number };

export async function deliverWebhook(job: Job<WebhookJob>, token?: string) {
  const { deliveryId } = job.data;
  const { rows } = await pool.query<Delivery>(
    `SELECT e.id AS "endpointId", e.url, e.secret, d.body, d.attempts
     FROM app.webhook_deliveries d JOIN app.webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.id = $1 AND d.status = 'pending' AND e.enabled`,
    [deliveryId],
  );
  const delivery = rows[0];
  // Already sent or given up on, or the address was turned off or deleted.
  if (!delivery) return { outcome: "skipped" };

  const attempt = delivery.attempts + 1;
  const { answer, lastAnswer } = await send(delivery);
  const step = nextDeliveryStep(answer, attempt);
  await pool.query(
    "UPDATE app.webhook_deliveries SET attempts = $2, status = $3, last_answer = $4 WHERE id = $1",
    [deliveryId, attempt, step.outcome === "retry" ? "pending" : step.outcome, lastAnswer],
  );

  if (step.outcome === "retry") {
    // Wait as long as the step says. The queue's own backoff would disagree with it.
    await job.moveToDelayed(Date.now() + step.afterSecs * 1000, token);
    throw new DelayedError();
  }
  if (step.outcome === "delivered") {
    await pool.query(
      `UPDATE app.webhook_endpoints SET consecutive_failures = 0
       WHERE id = $1 AND consecutive_failures > 0`,
      [delivery.endpointId],
    );
  } else {
    // Count a delivery that failed for good, never an attempt. One statement, so two failures at
    // the same moment cannot both read the old count.
    const { rows: trip } = await pool.query<{ tripped: boolean }>(
      `UPDATE app.webhook_endpoints
       SET consecutive_failures = consecutive_failures + 1,
           enabled = consecutive_failures + 1 < $2
       WHERE id = $1 AND enabled
       RETURNING NOT enabled AS tripped`,
      [delivery.endpointId, TURN_OFF_AFTER],
    );
    // True for exactly one failure, so this is where a mail to the owner would go.
    if (trip[0]?.tripped) logger.warn("turned a webhook off", { endpointId: delivery.endpointId });
  }
  return { outcome: step.outcome };
}

// One attempt. `answer` is null when nothing came back.
async function send({ url, secret, body }: Delivery) {
  // Sign each attempt, not each event: a receiver refuses a signature over five minutes old.
  const signature = await signWebhook({ secret, body });
  try {
    const result = await fetchPublic(url, {
      method: "POST",
      headers: { "content-type": "application/json", "notes-signature": signature },
      body,
      policy: webhookPolicy(env.webhooksToLocalhost),
      maxRedirects: 0,
      signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok) return { answer: null, lastAnswer: result.reason };
    // Nobody reads the answer's body. Cancel it, so the connection is freed.
    await result.response.body?.cancel();
    return { answer: result.response, lastAnswer: String(result.response.status) };
  } catch (error) {
    // Refused, timed out, or DNS failed. With no answer, the step is a retry.
    return { answer: null, lastAnswer: error instanceof Error ? error.message : String(error) };
  }
}
```

**Sign each attempt, not each event.** A receiver refuses a signature more than five minutes old,
and the last attempt goes out 450 seconds after the first.

**Follow no redirect.** The address was checked when it was saved, and the one a redirect points to
was not. `maxRedirects: 0` hands the redirect back as the answer. A receiver that answered 302 got
one request, and the delivery failed. Ask the user to add the final address.

**Give a slow receiver its own slot.** Each attempt waits up to 10 seconds. We added two receivers
for one user, one that answered at once and one that took 12 seconds, and sent 3 imports. With one
slot, the fast receiver's deliveries arrived about 0, 10 and 20 seconds after the imports. With
`concurrency: 10`, all three arrived in under half a second.

### Trying again

`nextDeliveryStep` reads the answer, or `null` when none came back, and says what happens next:
`delivered`, `retry` after `afterSecs`, or `failed`. What we measured:

| The receiver                        | What happened                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| answered 500 every time             | the first attempt, then 4 more at 30, 90, 210 and 450 seconds after it, then `failed` |
| answered 410                        | `failed` after 1 attempt                                                              |
| answered 302                        | `failed` after 1 attempt                                                              |
| answered 429 with `Retry-After: 45` | the next attempt 45 seconds later                                                     |
| was not running yet                 | `connect ECONNREFUSED`, then delivered on the next attempt                            |

**Wait as long as the step says.** `moveToDelayed` puts the job back on the queue until then, and
`DelayedError` tells BullMQ the job did not fail. The queue's own backoff is only for a failure on
our side, such as Postgres down.

**Count attempts on the delivery row.** BullMQ does not count an attempt you delayed this way.
After two attempts, the job still said `attemptsMade: 0`, and the row said 2. Counted on the job,
every attempt would be the first, and the delivery would never stop.

**Turn off an address that keeps failing.** Count deliveries that failed for good, never attempts:
the delivery that took 5 attempts added 1. We sent 12 imports at once to a receiver answering 410.
The count stopped at 10, the address was off, and the log said `turned a webhook off` once. It is
one SQL statement, so two failures at the same moment cannot both read the old count. A delivery
that goes through sets the count back to 0.

The owner sees `"enabled": false` in `GET /webhooks`, and adds the address again to turn it back
on. The log line is where a mail to them would go.
[Sending one, and trying again](server/README.md#sending-one-and-trying-again).

### Receiving one

A webhook address is public, so anyone can send to it. The signature is how the receiver knows the
request came from you. This small server stands in for the user's:

```ts
// apps/api/scripts/webhook-receiver.ts
// Stands in for a user's server, and receives the webhooks the worker sends. Run it with
// `WEBHOOK_SECRET=whsec_… bun scripts/webhook-receiver.ts`.
import { verifyWebhook } from "@gusnips/server";
import { Hono } from "hono";

// In memory, so a restart forgets. A real receiver keeps the ids in its database.
const seen = new Set<string>();

const app = new Hono();

app.post("/", async (c) => {
  // The raw text. JSON parsed and written out again is a different string, and never matches.
  const body = await c.req.text();
  const verdict = await verifyWebhook({
    secrets: [process.env.WEBHOOK_SECRET],
    header: c.req.header("notes-signature"),
    body,
  });
  if (!verdict.ok) {
    // One answer for every refusal. The reason goes in your log, never back to the sender.
    console.warn(`refused a webhook: ${verdict.reason}`);
    return c.body(null, 400);
  }

  const event: { id: string; type: string; data: { added: number } } = JSON.parse(body);
  // The same event can arrive twice. Answer 2xx again, and do nothing.
  if (seen.has(event.id)) return c.body(null, 204);
  seen.add(event.id);
  console.log(`received ${event.type} ${event.id}`);
  return c.body(null, 204);
});

export default { port: 4000, fetch: app.fetch };
```

**Check the raw text.** We sent a signed event with its JSON laid out again, and it was refused:
`bad-signature`. Parse the body only after it passes.

**Refuse a signature over five minutes old,** so a request someone recorded cannot be sent again
later. One signed 301 seconds ago was refused as `stale`, and one signed 299 seconds ago went
through.

**Answer every refusal the same way.** With no header, a wrong secret, a changed body or an old
signature, the answer was a bare 400. Only the log said why: `missing-header`, `bad-signature` or
`stale`. Telling the sender which check failed helps only somebody guessing.

**The same event can arrive twice.** We made a receiver take 12 seconds to answer. The worker gave
up at 10 seconds, then sent the event again 30 seconds later. It arrived twice, 40 seconds apart,
with the same `id`. So the receiver answers 2xx again and does nothing.

**Write the port in the file.** Bun loads the `.env` of the folder it runs in, and `PORT` in
`apps/api/.env` is the API's. Reading `PORT`, the receiver tried the API's port and stopped with
`EADDRINUSE`.

Supabase Auth's hooks use a second format, Standard Webhooks. `verifyStandardWebhook` checks it.
[A webhook](server/README.md#a-webhook).

### Run it

Run the new migration from `apps/api` with `bun run migrate`. Start the API and the worker with
`bun run dev`, then add an address:

```bash
curl -X POST http://localhost:3000/webhooks \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"url":"http://localhost:4000/"}'
```

The answer holds the secret:

```text
{"data":{"id":"…","url":"http://localhost:4000/","secret":"whsec_…"}}
```

Start the receiver from `apps/api` with that secret:

```bash
WEBHOOK_SECRET=whsec_… bun scripts/webhook-receiver.ts
```

Then send an import:

```bash
curl -X POST http://localhost:3000/notes/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"titles":["Water the plants","Pay the rent","Call grandma"]}'
```

The receiver prints:

```text
Started development server: http://localhost:4000
received import.done 79ae1594-1cc8-4c4e-a4ce-46241832b828
```

## An OpenAPI reference

An OpenAPI reference is one file that lists every route: what it reads, what it answers, and how it
fails. Docs sites, client generators and AI agents read it. `@gusnips/server/openapi` builds it
from the same zod schemas the routes check requests with.

### One file of schemas

The schemas move out of the routes into one file:

```ts
// apps/api/src/schemas.ts
// What the routes read and answer. The routes check each request with these, and openapi.ts
// builds the reference from the same ones, so the two cannot disagree.
import { z } from "zod";

const Title = z.string().trim().min(1).max(200);

export const Note = z.object({ id: z.uuid(), title: z.string(), createdAt: z.iso.datetime() });
export const NewNote = z.object({ title: Title }).strict();
export const NewImport = z.object({ titles: z.array(Title).min(1).max(1_000) }).strict();
export const ImportStarted = z.object({ importId: z.uuid() });

export const Webhook = z.object({
  id: z.uuid(),
  url: z.url(),
  enabled: z.boolean(),
  consecutiveFailures: z.int(),
});
export const NewWebhook = z.object({ url: z.string().trim().max(2_000) }).strict();
export const WebhookAdded = z.object({ id: z.uuid(), url: z.url(), secret: z.string() });
export const WebhookId = z.object({ id: z.uuid() }).strict();
```

`app.ts` imports `NewNote` and `NewImport` from it, and `webhooks.ts` imports `NewWebhook` and
`WebhookId`. The delete now reads its id with `WebhookId.parse({ id: c.req.param("id") })`, and
answers with the kit's `noContent(c)`.

**Build the reference from the schemas the routes use.** A title of 201 characters got a 400 from
the route, and the reference says `maxLength: 200`, because both read `Title`. Two copies of a
limit drift apart. One copy cannot.

### The reference

Move `@gusnips/server` to `^0.8.22` in the catalog, and run `bun install`. On 0.8.22 the reference
documents the delete's 204 with no body, which matches what `noContent` sends. On 0.8.21 it
described a JSON `{ data }` body that the route never sent.

```ts
// apps/api/src/openapi.ts
import {
  buildOpenApi,
  createOpenApiResponder,
  type OpenApiOperation,
} from "@gusnips/server/openapi";
import { z } from "zod";
import { env } from "./env.ts";
import { ERROR_STATUS } from "./errors.ts";
import {
  ImportStarted,
  NewImport,
  NewNote,
  NewWebhook,
  Note,
  Webhook,
  WebhookAdded,
  WebhookId,
} from "./schemas.ts";

// Every route a signed-in user can call, as the router spells it.
const OPERATIONS: OpenApiOperation[] = [
  {
    name: "list_notes",
    method: "get",
    path: "/notes",
    tag: "Notes",
    summary: "List your notes",
    description: "Newest first.",
    response: z.array(Note),
  },
  {
    name: "add_note",
    method: "post",
    path: "/notes",
    tag: "Notes",
    summary: "Add a note",
    input: NewNote,
    response: Note,
    status: 201,
  },
  {
    name: "import_notes",
    method: "post",
    path: "/notes/import",
    tag: "Notes",
    summary: "Add many notes at once",
    description:
      "Answers before the notes are written. They show up in your list a moment later, and your " +
      "webhooks hear about it.",
    input: NewImport,
    headers: [
      {
        name: "Accept-Language",
        description: "The language of the email that says the import is done: en or pt-BR.",
      },
    ],
    response: ImportStarted,
    status: 202,
    errors: { 503: "Imports are paused. Try again in a minute." },
  },
  {
    name: "list_webhooks",
    method: "get",
    path: "/webhooks",
    tag: "Webhooks",
    summary: "List your webhooks",
    description: "An address that kept failing shows `enabled: false`. Add it again to turn it on.",
    response: z.array(Webhook),
  },
  {
    name: "add_webhook",
    method: "post",
    path: "/webhooks",
    tag: "Webhooks",
    summary: "Add a webhook",
    description: "The answer holds the secret that signs each delivery. It is shown this once.",
    input: NewWebhook,
    response: WebhookAdded,
    status: 201,
    errors: { 503: "We could not look up the address just now. Try again in a minute." },
  },
  {
    name: "delete_webhook",
    method: "delete",
    path: "/webhooks/:id",
    tag: "Webhooks",
    summary: "Delete a webhook",
    input: WebhookId,
    status: 204,
    errors: { 404: "You have no webhook with that id." },
  },
];

// GET /openapi.json. The document is built on the first request, then kept.
export const reference = createOpenApiResponder(() =>
  buildOpenApi(OPERATIONS, {
    info: { title: "Notes API", version: "1.0.0" },
    // From config. Behind a proxy, every request reaches the API on 127.0.0.1, so a reference
    // built from the request would send every reader there.
    origin: env.apiUrl,
    basePath: "",
    tags: [
      { name: "Notes", description: "Your notes." },
      { name: "Webhooks", description: "Addresses we call when one of your imports is done." },
    ],
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "The access token you sign in for.",
      },
    },
    errors: {
      400: "The input is wrong. The message says what.",
      401: "The token is missing or has expired. Sign in again.",
      500: "Something on our side failed. Quote the request id when you write to us.",
    },
    errorCodes: Object.keys(ERROR_STATUS),
  }),
);
```

`app.ts` serves it before the guards, and the guard test adds `/openapi.json` to `isPublic`:

```ts
// apps/api/src/app.ts, before the guards
// Every route, for docs sites, client generators and agents. Public, like the docs.
app.get("/openapi.json", (c) => reference(c.req.query("lang")));
```

**`origin` comes from config.** The API gets `API_URL` in its `.env`, as the worker did in
[Sending mail](#sending-mail). Left out, the API stopped at boot:

```text
The environment has 1 problem:
- These are not set: API_URL
Copy apps/api/.env.example to apps/api/.env and fill it in.
```

**`basePath` is required, even when it is `""`.** The server's address and the path together make
each route's address. These routes sit at the root, so it is empty.

**An operation id is used once.** It is the operation's `name` unless you pass `operationId`. We
listed one operation twice, on two paths, and the build threw:

```text
Error: GET /notes/all and GET /notes share the operation id "list_notes". Give one an `operationId`.
```

**`errorCodes` lists every code the API answers with.** `ERROR_STATUS` has one entry for each code,
and the type makes sure of it, so `Object.keys(ERROR_STATUS)` is the whole list. The reference's
`ApiError` then names all six, so a client built from it can check a code by name.

The API's tests read the same env check, so `vitest.config.ts` gets `API_URL` too. With
`REDIS_URL` left out of it, the tests stopped with `These are not set: REDIS_URL`. The whole list
now reads:

```ts
// apps/api/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/notes_test",
      // Nothing listens on port 1, so no test reaches a Redis you are using.
      REDIS_URL: "redis://127.0.0.1:1",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_ANON_KEY: "test",
      APP_URL: "http://localhost:5173",
      API_URL: "http://localhost:3000",
      UNSUBSCRIBE_SECRET: "a-test-secret-that-is-long-enough-000",
      LOG_LEVEL: "silent",
    },
  },
});
```

To serve the reference in Portuguese too, pass `createOpenApiResponder` one function for each
language.
[A reference for your API](server/README.md#a-reference-for-your-api).

A typed client built from this file, with `@gusnips/sdkgen`, comes in a later part.

### Run it

```bash
curl http://localhost:3000/openapi.json
```

The answer is an OpenAPI 3.1 document with the six operations above. Check it with Redocly's
linter:

```bash
bunx @redocly/cli lint http://localhost:3000/openapi.json
```

Version 2.54.3 found it valid, with two warnings: it names no license, and its server is
localhost. To read it as a web page:

```bash
bunx @redocly/cli build-docs http://localhost:3000/openapi.json
```

That writes `redoc-static.html`, a single page with every route, grouped under `Notes` and
`Webhooks`.

## A public API

So far only the web app calls the API, with the token a person gets when they sign in. A user's own
script cannot sign in that way. This chapter gives it an API key to send instead, limits how many
requests each user sends in a minute, and opens an MCP door. MCP (Model Context Protocol) is how an
AI agent calls tools on a server.

The last chapter moved `@gusnips/server` to `^0.8.22`, which already has a fix this chapter needs.
We made the limiter's Redis connection and counted two requests right away, as the first requests
after a boot would be. On 0.8.19 both counts failed, so the limiter let both requests through
uncounted. On 0.8.21 and 0.8.22 both were counted.

### API keys

An API key is a long random string that a user's code sends in place of a sign-in token. A new
migration keeps them:

```sql
-- apps/api/migrations/005_api_keys.sql
-- Keys a user's own code sends instead of signing in. We keep a hash of each key, never the key.
CREATE TABLE app.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- So the user can tell their keys apart: "Laptop", "Backup script".
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_user_id_idx ON app.api_keys (user_id);
```

`schemas.ts` gets their shapes:

```ts
// apps/api/src/schemas.ts, added at the end
export const ApiKey = z.object({ id: z.uuid(), name: z.string(), createdAt: z.iso.datetime() });
export const NewApiKey = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const ApiKeyAdded = z.object({ id: z.uuid(), name: z.string(), key: z.string() });
export const ApiKeyId = z.object({ id: z.uuid() }).strict();
```

`"FORBIDDEN"` joins `ErrorCode` in `packages/shared`, `ERROR_STATUS` gets `FORBIDDEN: 403`, and
`errors` gets two more:

```ts
// apps/api/src/errors.ts, in errors
  badKey: () => appError("UNAUTHORIZED", "That API key does not work. It may have been deleted."),
  forbidden: (message: string) => appError("FORBIDDEN", message),
```

`AppEnv` says how a request came in:

```ts
// apps/api/src/app.ts, near the top
export type AppEnv = {
  Variables: RequestVariables<ErrorCode> & {
    userId: string;
    email: string | null;
    // Set when the request came with an API key instead of a sign-in.
    apiKeyId: string | null;
  };
};
```

`auth.ts` makes keys and checks them, and `requireUser` now takes either kind:

```ts
// apps/api/src/auth.ts
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { guard } from "@gusnips/server/hono";
import { isAuthOutage } from "@gusnips/server/supabase";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./app.ts";
import { pool } from "./db.ts";
import { env } from "./env.ts";
import { errors } from "./errors.ts";

const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Every key starts with this, so requireUser can tell a key from a sign-in token.
const API_KEY_PREFIX = "notes_";

export const newApiKey = () => API_KEY_PREFIX + randomBytes(32).toString("base64url");

// We store this hash, never the key. A key is 32 random bytes, so nobody can work it out from the
// hash, and a fast hash lets Postgres find the key's row by its index.
export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

// A signed-in user from the web app, or a user's own code with one of their API keys.
export const requireUser = guard(
  createMiddleware<AppEnv>(async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /i, "");
    if (!token) throw errors.unauthorized();

    if (token.startsWith(API_KEY_PREFIX)) {
      const { rows } = await pool.query<{ id: string; userId: string }>(
        `SELECT id, user_id AS "userId" FROM app.api_keys WHERE key_hash = $1`,
        [hashApiKey(token)],
      );
      if (!rows[0]) throw errors.badKey();
      c.set("userId", rows[0].userId);
      // A key has no mail address, so an import it starts sends no mail. Its webhooks still fire.
      c.set("email", null);
      c.set("apiKeyId", rows[0].id);
      return next();
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (isAuthOutage(error)) throw errors.unavailable("Sign-in is not answering right now");
    if (error || !data.user) throw errors.unauthorized();

    c.set("userId", data.user.id);
    c.set("email", data.user.email ?? null);
    c.set("apiKeyId", null);
    await next();
  }),
);
```

**Keep the hash, never the key.** The table holds a 64-character SHA-256 hash of each key. Someone
who reads the table, or a backup of it, gets nothing that works: sent as a key, a hash from the
table got a 401. A slow hash such as bcrypt is for passwords people choose. A key is 32 random
bytes, so a fast hash is enough, and Postgres finds it by its index.

**A failed lookup is not a wrong key.** With Postgres stopped, a request with a good key got a 500,
`Something on our side failed`. A 401 there would tell the user their key is wrong, and they might
delete a key that works.

The routes:

```ts
// apps/api/src/apiKeys.ts
import { created, noContent, ok } from "@gusnips/server/hono";
import { Hono } from "hono";
import type { AppEnv } from "./app.ts";
import { hashApiKey, newApiKey } from "./auth.ts";
import { pool } from "./db.ts";
import { errors } from "./errors.ts";
import { ApiKeyId, NewApiKey } from "./schemas.ts";

export const apiKeys = new Hono<AppEnv>();

// Only a signed-in user manages keys. A key that leaked must not be able to make more.
apiKeys.use(async (c, next) => {
  if (c.get("apiKeyId")) throw errors.forbidden("Sign in to manage API keys. A key cannot.");
  await next();
});

apiKeys.get("/", async (c) => {
  const { rows } = await pool.query<{ id: string; name: string; createdAt: Date }>(
    `SELECT id, name, created_at AS "createdAt" FROM app.api_keys
     WHERE user_id = $1 ORDER BY created_at`,
    [c.get("userId")],
  );
  return ok(c, rows);
});

// The answer holds the key, this once. We only keep its hash, so we cannot show it again.
apiKeys.post("/", async (c) => {
  const { name } = NewApiKey.parse(await c.req.json().catch(() => null));
  const key = newApiKey();
  const { rows } = await pool.query<{ id: string; name: string }>(
    `INSERT INTO app.api_keys (user_id, name, key_hash) VALUES ($1, $2, $3) RETURNING id, name`,
    [c.get("userId"), name, hashApiKey(key)],
  );
  return created(c, { ...rows[0], key });
});

// Works at once: the next request with that key gets a 401.
apiKeys.delete("/:id", async (c) => {
  const { id } = ApiKeyId.parse({ id: c.req.param("id") });
  const { rowCount } = await pool.query(
    `DELETE FROM app.api_keys
     WHERE id = $1 AND user_id = $2`,
    [id, c.get("userId")],
  );
  if (!rowCount) throw errors.notFound("API key");
  return noContent(c);
});
```

They mount at the end of `app.ts`. `perUser` is the limit in the next section.

```ts
// apps/api/src/app.ts, at the end
// Where a user makes the keys their own code sends instead of signing in.
app.use("/keys/*", requireUser, perUser);
app.route("/keys", apiKeys);
```

**Only a signed-in user manages keys.** Sent with a key, `GET /keys` and `POST /keys` got a 403,
`Sign in to manage API keys. A key cannot.` Otherwise a key that leaked could make a new key, and
deleting the leaked one would not lock anyone out.

**The key is shown once.** The answer to the POST holds it, and `GET /keys` shows names only. A
delete works at once: the next request with that key got a 401,
`That API key does not work. It may have been deleted.`

**A key has no mail address.** An import started with a key sent no mail, and the same import from
the web app sent one. The user's webhooks still heard about it.

### A rate limit

A rate limit caps how many requests one user sends in a minute. The count lives in Redis, so it
holds across a restart:

```ts
// apps/api/src/limits.ts
import { rateLimit } from "@gusnips/server/hono";
import { createRedis, redisWindowStore } from "@gusnips/server/redis";
import type { AppEnv } from "./app.ts";
import { env } from "./env.ts";
import { errors } from "./errors.ts";
import { logger } from "./logger.ts";

// Its own connection, one that fails at once when Redis is down, so no request waits on it.
export const limitsRedis = createRedis({
  url: env.redisUrl,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 1_000,
  onError: (error) => logger.error("[redis] limiter connection error", { error }),
});

// The count for each user and each minute lives in Redis, so it holds across a restart.
export const limits = redisWindowStore(limitsRedis, { timeoutMs: 500 });

// 300 requests a minute for each user, signed in or with a key.
export const perUser = rateLimit<AppEnv>({
  scope: "api",
  store: limits,
  // With Redis down, let requests through instead of refusing everyone. The log says so.
  whenStoreFails: "allow",
  logger,
  limit: 300,
  windowMs: 60_000,
  key: (c) => c.get("userId"),
  refuse: (hit) => errors.rateLimited(hit.retryAfterSecs),
});
```

`perUser` goes after `requireUser` on `/notes/*` and `/webhooks/*` too, as on `/keys/*` above. The
drain closes its connection:

```ts
// apps/api/src/index.ts, in the drain
{ name: "redis", run: () => Promise.all([quitRedis(redis), quitRedis(limitsRedis)]) },
```

**Count the user, after the guard.** `key` reads the `userId` that `requireUser` checked. A limit
that counted the raw token would count whatever string a caller sends, so each new string would be
a new allowance. We sent 301 requests with one key in a minute. 300 got a 200, and the 301st got:

```text
429 Too Many Requests
Retry-After: 52
{"error":{"code":"RATE_LIMITED","message":"Too many requests","details":{"retryAfterSecs":52}}}
```

The minutes follow the clock: that request came 8.9 seconds past the minute, so 52 seconds were
left. A request with the same user's sign-in token got a 429 too, because a key and a sign-in count
as one user. Another user got a 200.

**Give the limiter its own connection.** With Redis stopped, requests still got a 200, most in 7 ms,
and the log said `[rate-limit] the store did not answer` for each one. We then built the store on
the API's main connection instead, and stopped Redis again. Each request waited about half a
second, the whole `timeoutMs`, because that connection holds a command until Redis is back.

**Choose what a Redis outage means.** `whenStoreFails` has no default. `"allow"` fits this limit:
refusing every user over a Redis blip is worse than a minute with no limit. A limit that guards a
bill, such as a form that sends mail to strangers, passes its 503 instead.
[A rate limit](server/README.md#a-rate-limit).

### An MCP door

The door serves two tools, `list_notes` and `add_note`, at `POST /mcp`. Add
`"@modelcontextprotocol/sdk": "^1.30.1"` to the catalog and to the API.

A tool and its route should run the same query, so the queries move out of `app.ts`:

```ts
// apps/api/src/notes.ts
// The queries behind GET and POST /notes. The MCP tools run the same two.
import { pool } from "./db.ts";

type NoteRow = { id: string; title: string; createdAt: Date };

export async function listNotes(userId: string) {
  const { rows } = await pool.query<NoteRow>(
    `SELECT id, title, created_at AS "createdAt" FROM app.notes
     WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

export async function addNote(userId: string, title: string) {
  const { rows } = await pool.query<NoteRow>(
    `INSERT INTO app.notes (user_id, title) VALUES ($1, $2)
     RETURNING id, title, created_at AS "createdAt"`,
    [userId, title],
  );
  return rows[0];
}
```

```ts
// apps/api/src/app.ts, the notes routes
app.get("/notes", async (c) => ok(c, await listNotes(c.get("userId"))));

app.post("/notes", async (c) => {
  const { title } = NewNote.parse(await c.req.json().catch(() => null));
  return created(c, await addNote(c.get("userId"), title));
});
```

The door:

```ts
// apps/api/src/mcp.ts
import { hitWindow } from "@gusnips/server";
import { mcpRoutes, registerOperation, type ToolOperation } from "@gusnips/server/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "./app.ts";
import { errorResponse, errors } from "./errors.ts";
import { limits } from "./limits.ts";
import { logger } from "./logger.ts";
import { addNote, listNotes } from "./notes.ts";
import { NewNote } from "./schemas.ts";

type Deps = { userId: string };

// What an agent can do, as tools. Each runs the same query as its REST route.
const TOOLS: ToolOperation<Deps, unknown, unknown>[] = [
  {
    name: "list_notes",
    description: "List the user's notes, newest first.",
    inputSchema: z.object({}).strict(),
    run: ({ userId }: Deps) => listNotes(userId),
  },
  {
    name: "add_note",
    description: "Add a note to the user's list.",
    inputSchema: NewNote,
    run: ({ userId }: Deps, { title }: z.infer<typeof NewNote>) => addNote(userId, title),
  },
];

function buildMcpServer(c: Context<AppEnv>) {
  const server = new McpServer({ name: "notes", version: "1.0.0" });
  const userId = c.get("userId");
  for (const tool of TOOLS) {
    registerOperation(server, tool, {
      errorResponse,
      logger,
      requestId: c.get("requestId"),
      deps: () => ({ userId }),
      // Runs before each tool call. One request can carry many calls, so the limit counts calls.
      beforeCall: async () => {
        const hit = await hitWindow(limits, `mcp:${userId}`, {
          limit: 60,
          windowMs: 60_000,
          whenStoreFails: "allow",
        });
        if (hit.outcome === "store-failed") {
          logger.warn("[mcp] call not counted: Redis did not answer", { error: hit.error });
        }
        if (hit.outcome === "limited" || hit.outcome === "shed") {
          throw errors.rateLimited(hit.retryAfterSecs);
        }
      },
    });
  }
  return server;
}

// POST /mcp and /mcp/. Agents and scripts send no Origin header. No web page may call it.
export const mcp = mcpRoutes("/mcp", buildMcpServer, { allowedOrigins: new Set() });
```

```ts
// apps/api/src/app.ts, at the end
// The same notes, for AI agents. The door counts each tool call, so it gets no perUser.
app.use("/mcp/*", requireUser);
app.route("/", mcp);
```

**Count tool calls, not requests.** One POST can carry many calls. We sent one POST with 61 calls.
60 were answered, and the 61st got the same 429 body as REST, with `"retryAfterSecs":58`. `perUser`
on this route would have counted that POST once.

**Guard `"/mcp/*"`, not `"/mcp"`.** The door answers at `/mcp` and at `/mcp/`. With `"/mcp"`, the
guard test failed:

```text
Error: 1 endpoint(s) answer with no guard running in front of them:
  ALL /mcp/
```

**Pass the zod object, not its `.shape`.** With `NewNote.shape`, the typecheck failed:
`Type '{ title: ZodString; }' is not assignable to type 'AnySchema'.` With the strict object, an
argument the agent made up is refused by name: `Unrecognized key: "pinned"`.

**A tool answers like its route.** A tool sends back the REST body, `{ data }`, as text. With
Postgres stopped, `add_note` answered
`{"error":{"code":"INTERNAL_ERROR","message":"Something on our side failed"}}`, marked `isError`.
The database's address went to the log, under `tool failed`, with the request id, and never to the
agent.

**No web page may call it.** A request with an `Origin` header got a 403, and a GET got a 405.
Agents and scripts send no `Origin`.
[An MCP door](server/README.md#an-mcp-door).

### The reference

`openapi.ts` lists the three key routes under a new `API keys` tag, each with its 403. The shared
`errors` get a 429, and the reference then shows the `Retry-After` header on every route.
`bearerAuth` now says a key works too. Redocly still found the document valid. The MCP tools are
not REST routes, so they are not in it.

### Run it

Run the new migration from `apps/api` with `bun run migrate`, and start the API with `bun run dev`.
Make a key with your sign-in token:

```bash
curl -X POST http://localhost:3000/keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"Laptop"}'
```

```text
{"data":{"id":"…","name":"Laptop","key":"notes_…"}}
```

Put the key in `$KEY`, and read your notes with it:

```bash
curl http://localhost:3000/notes -H "Authorization: Bearer $KEY"
```

Then call a tool, the way an agent does:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add_note","arguments":{"title":"Buy milk"}}}'
```

```text
{"result":{"content":[{"type":"text","text":"{\"data\":{\"id\":\"…\",\"title\":\"Buy milk\",\"createdAt\":\"…\"}}"}]},"jsonrpc":"2.0","id":1}
```

Without the `accept` header, the answer is a 406. An MCP client connects with the address
`http://localhost:3000/mcp` and the same `Authorization` header. The SDK's own client listed both
tools and added a note.
