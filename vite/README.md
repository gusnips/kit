# @gusnips/vite

Turn a Vite + React SPA's public routes into real HTML files at build time: a real `<head>`, a
real body, one file per page.

```bash
bun add -d @gusnips/vite
```

```ts
import { pageFile } from "@gusnips/vite";

pageFile("/pricing"); // → "pricing.html"
```

## Why bother

A Vite SPA ships one `index.html` and draws everything else with JavaScript. Nothing that reads a
link for a living runs that bundle: not a search crawler, not an LLM, not the thing that draws
the preview card when someone pastes your link in a chat. A shipped `<div id="root"></div>` is a
page that can be listed and never quoted.

So the build renders each public route to its own file. This is the part every app doing that
ends up writing.

## Baking a page

```ts
import { bakeHead } from "@gusnips/vite";

const html = bakeHead(template, {
  title: "Pricing | Example",
  description: "What it costs.",
  canonical: "https://example.com/pricing",
  body: { route: "/pricing", html: rendered },
});
```

`bakeHead` rewrites the title, the description, the canonical, the Open Graph and Twitter tags,
`<html lang>`, the `hreflang` set, and injects the rendered markup into `<div id="root">`.

Four rules in there are load-bearing:

- **`canonical: null` strips the tag, and `og:url` with it.** For the 404 shell, which is served
  for every address that does not exist. Blanking is not stripping: an empty canonical is a claim
  about `""`, and an empty `og:url` is a card pointing at your front page. **Leave `image` out
  there too**, and the shell keeps the card your template already has. The image is the half
  people miss, and `bakeHead` cannot catch it for you. It writes whatever card you name. Three
  codebases named the shell's card after its made-up path, so their `404.html` advertised
  `/og/__not-found__.png`, a file that has never existed. Every share of a dead link unfurled
  broken, and nothing in a browser showed it.
- **`og:locale` is not optional on a non-English page.** Leave it out and the spec does not
  default it to "unknown". It defaults to `en_US`. A Portuguese page with a Portuguese
  `og:title` then tells every share crawler the card is English. `ogLocale("pt-BR")` gives you
  the underscore spelling it actually wants.
- **`body` carries the route, not just the markup.** A static host answers every address it does
  not publish with the nearest `404.html`, and that file has the not-found page rendered _into_
  it. So "does the root have children" is the wrong question: a route served from the shell finds
  a full root, hydrates, and React reconciles two different pages. It recovers by throwing the
  tree away and logging: a page that works, and a bug nobody sees. The marker is what the
  browser entry compares against before it decides.
- **`alternates` must be reciprocal.** A crawler ignores the whole set unless every address in it
  points back at the others, which is why you pass the full list to every page rather than "the
  other two".

## Rendering

```ts
import { renderTree } from "@gusnips/vite/render";
```

Behind its own subpath, because it is the one thing here that loads React. A repo that only wants
a sitemap installs no renderer.

Your SSR entry exports a function named `renderPage` that calls it. The prerender script loads it
with `loadRenderer("dist-ssr/entry-server.js")`, which looks for that name and stops the build if
it is not there.

It uses `prerender` from `react-dom/static`, never `renderToString`. With `lazy()` routes behind
a `<Suspense>`, **`renderToString` renders the fallback**. It will write a loading screen into
every file and pass any gate that only asks whether the root has children. It also answers `""`
for a basename mismatch with no error and no warning, so `assertRendered` checks every route for
non-empty output. And React 19 hoists in-tree `<title>` and `<meta>` to the front of the server
stream, which lands them inside your body when you are filling one `<div>` rather than assembling
a document, so those get stripped, and a render error is rethrown so a broken page fails the
build instead of shipping.

The fallback is not the worst case. `renderToString` can write its own ERROR into the page: one
repo shipped a live, indexed reference page carrying React's "does not support Suspense" message,
a stack trace, and five copies of an absolute path from the machine that built it. Nothing in a
browser shows it, because the bundle replaces the body on load, so the only readers who ever saw
it were the ones who run no JavaScript, which is every crawler the page was built for. It was in
one of its two languages, too: the first render bails but resolves the `lazy()` promise, so the
next locale rendered the real component and looked perfect. `assertRendered` refuses that text now.

Call `assertRendered(file, html, template)` on every page before you write it. It stops the build
when:

- the page is less than 500 bytes bigger than `index.html`. A page that is short on purpose
  passes a lower floor: `{ minGrowth: 200 }`.
- the `<title>` is empty, or, when you pass `{ lang }`, `<html lang>` names another language.
- a `%NAME%` placeholder was never filled in.
- React's `renderToString` error is in the page.
- the page is the loading screen. It knows one only by `role="status"`, so give your Suspense
  fallback that role, which a screen reader needs anyway. A plain `<p>Loading…</p>` passes.

End your prerender script with `process.exit(0)`. Under bun, importing this renderer leaves the
process alive after the last file is written: `react-dom/server` exits, `react-dom/static.browser`
does not, and `process.getActiveResourcesInfo()` shows nothing either way, so the only symptom is a
script that finishes its work and never returns. Node 26 does the same (measured with react-dom
19.3). We do not call `exit` for you (a library killing its host process is worse than the hang),
and in CI the alternative is a job that builds everything and then runs to its timeout.

## Flat files

That `pageFile` at the top writes `pricing.html`, not `pricing/index.html`. Nested routes keep
their folders: `/guides/errors` → `guides/errors.html`.

Every address your app puts in a canonical or a sitemap has to answer 200 rather than redirect. On
Cloudflare Pages that means flat files: it serves `pricing/index.html` at `/pricing/` and answers
`/pricing` with a 308. A flat file answers `/pricing` with a 200 and normalizes `/pricing/` to it
with a 308, so the form you advertise is the form that is a page, which is the whole point.

This page said "a flat file answers both" until somebody ran the `curl -I` the next paragraph asks
for: `/precos/` came back `308`, `location: /precos`. Nothing about the rule changed, but the
detail matters when you are deciding whether a slash-tolerant hydration check is fixing anything:
on a host that normalizes, the browser is redirected before your bundle runs, so it never can.

Hosts differ, though. Firebase Hosting redirects `/pricing` to `/pricing/` by default, and serves
`pricing/index.html` at `/pricing` itself once `trailingSlash` is `false`. On a host like that,
write the directory form and set the flag. Either way, run `curl -I` on one page before you trust
the sitemap.

## Sitemap, robots, OG cards

`sitemapFor(origin, pages)` walks your page registry; `robotsTxt({ origin, sitemaps })` generates
the file, listing every sitemap in one, because a crawler only reads the one at the origin root:
a subdirectory app cannot ship its own.

`sitemapXml` takes `priority` **pre-formatted, as a string**. Ranking pages is a decision that
belongs to whoever walks the registry: one codebase reads a field off its own registry, another
gives the front door 1.0 and every guide 0.8 flat, because ranking one guide above another would
be a guess about a reader.

`writeOgCards` walks the registry and calls a renderer you supply, and `fitText` does the
text-fitting maths. When copy does not fit, it **records the overflow and refuses to write**
rather than appending an ellipsis: an ellipsis makes every string "fit", so copy that outgrew
its column has no failing case and ships.

`assertOgImages("dist", origin)` reads every page the build wrote and checks that each share card
it advertises is a file that exists. Run it last:

```ts
await assertOgImages("dist", "https://example.com");
```

Three codebases shipped a `404.html` whose `og:image` named a card nothing had ever rendered:
the card generator walks the page registry, and a not-found shell is not in it. Every share of a
dead link unfurled broken, and nothing in a browser shows it. `bakeHead` cannot catch this: it
writes the image it is handed, and a shell carrying the brand card is correct. The build can,
because by then the card is on disk or it is not. Cards on another host are skipped.

`loadTemplate` refuses a `dist/index.html` that is already a rendered page. `dist/index.html` is
both the file every page is baked _from_ and the home page's own output, so a second pass over a
written `dist/` reads a finished page as its blank and nests one render inside another. `vite
build` empties `dist/` and normally makes that impossible: a restored build cache and a hand-run
of the script both route around it.

## Theme before the first frame

```ts
import { themeScript } from "@gusnips/vite/theme";

export default defineConfig({ plugins: [themeScript({ key: "app.theme" })] });
```

Writes `assets/theme-<hash>.js` and one `<script src>` at the end of `<head>`, so the page is
painted in the reader's theme before anything else runs. The file is the source of `startTheme`
from `@gusnips/react/theme`, so the script before paint and the controller the app uses are
the same function. It is a file rather than an inline script so a `script-src 'self'` policy
lets it run. Pass it the same options you pass `createTheme`; see that package's README. On
[the preset](#the-vite-preset), put it in `plugins`.

`themeScript` is built on `prePaintScript`, which takes any script that has to run before the
page shows. `@gusnips/locale`'s `localeGateScript` is the other one:

```ts
import { prePaintScript } from "@gusnips/vite";

prePaintScript({ name: "locale", source: localeGateScript({ ... }), position: "head-prepend" });
```

The script runs on its own, before your bundle, so it must not use anything outside itself. The
tag goes at the end of `<head>` by default. `position: "head-prepend"` puts it first instead, so
it does not wait for your stylesheets to download. Use that for a script that may leave the page.

## Check your translations

```ts
// scripts/check-i18n.ts
import { readFile } from "node:fs/promises";
import { checkI18n, formatI18nReport, type I18nBundle } from "@gusnips/vite/i18n";

const web: I18nBundle = {
  name: "web",
  locales: ["en", "pt-BR", "es"],
  canonical: "en",
  load: async (locale) => ({
    translation: JSON.parse(await readFile(`src/i18n/locales/${locale}.json`, "utf8")),
  }),
};

const report = await checkI18n([web]);

console.log(formatI18nReport(report));
process.exit(report.problems.some((p) => p.level === "error") ? 1 : 0);
```

Your `canonical` language is typed, so a `t("key")` it lacks already fails to compile. The other
languages are not, and neither is anything inside a string. This checks what the compiler can't:

| It fails when                                                  | Because the reader gets                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| a key is in one language and not another, or is blank          | the canonical language, in the middle of their own         |
| a counted key lacks a form its language needs (pt `_many`)     | the fallback language at exactly 1,000,000, or the raw key |
| `{{name}}` became `{{nome}}`, or `{{n, number}}` lost `number` | a gap, or 5000 where they write 5.000                      |
| `<0>…</0>` is out of order or not closed                       | the wrong words bold, or the tag as text                   |
| a placeholder is named `lng`, `ns` or another `t()` option     | another language, not the value                            |
| a language fails to load                                       | nothing: every other rule would have passed it empty       |

`load` returns one language's catalogs by namespace, so JSON files, TS modules and a runtime
merge all fit. If it throws, the check fails with the error. It never skips.

Give it `code` and it reads your source too: every static `t("key")` exists, a template key's
fixed start exists (``t(`plan.${id}.title`)`` needs `plan`), `<Trans>` has no children (they
shift every `<0>`), and copy with `<strong>` in it is not read through `t()`, which prints the
tag as text.

```ts
await checkI18n([{ ...web, code: ["src/**/*.{ts,tsx}"] }]);
```

Keys the server sends are shown in whatever language the reader has, so each one must be in every
language. Pass the list if you can import it, or the server's source to scan for `messageKey:`:

```ts
await checkI18n([{ ...web, serverKeys: MESSAGE_KEYS }]);
// or, with no list to import:
await checkI18n([
  { ...web, serverCode: ["apps/api/src/**/*.ts"], serverKeyPrefixes: ["serverErrors."] },
]);
```

The scan reads text, not syntax, so a `t("key")` inside a comment counts too, and fails the check
if the key is gone. Fix the comment. Skipping comments safely would take a full parser: a pattern
that cuts a line at `//` also cuts it at `https://`, and would quietly miss a real `t()` after it.

`report.unused` lists canonical keys no code seems to reach. It is a hint, not a failure: a key
built at runtime from a variable can't be seen by a scan.

If your prices come from a formatter, pass `{ price: /\$\s?\d/ }` as the second argument and a
price typed into copy fails too.

**Fragments.** If several people write screens at once, keep one file per area with every
language side by side (`{ "en": {…}, "pt-BR": {…} }`) and merge them. `writeFragments` writes
`out/<locale>.json` with sorted keys, so two runs write the same bytes, and writes nothing if two
fragments disagree. The check then fails if a committed catalog no longer matches its fragments:

```ts
await checkI18n([{ ...web, fragments: { dir: "src/i18n/fragments", out: "src/i18n/locales" } }]);
```

If the app merges fragments at runtime with a spread (`{ ...auth.en, ...nav.en }`), leave `out`
off and set `ownTopLevel: true`. A spread keeps only the second of two fragments that share a
top-level key, so that is refused.

## Check your contrast

```ts
// scripts/check-contrast.ts
import { checkContrast, formatContrastReport } from "@gusnips/vite/contrast";

const report = await checkContrast([
  { name: "web", entry: "src/index.css", sources: ["src/**/*.{ts,tsx}"] },
]);

console.log(formatContrastReport(report));
process.exit(report.problems.some((p) => p.level === "error") ? 1 : 0);
```

The tokens package measures the placeholder colours it ships. This measures yours: it compiles
your entry with the real Tailwind CLI and reads the CSS that comes back.

| It fails when                                                      | Because the reader gets                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `--color-input` is under 3:1 on `--color-background`, either mode  | a field border some people cannot see                     |
| `--color-foreground` is under 4.5:1 on the background, either mode | body copy some people cannot read                         |
| `--color-primary` is the same fill in both modes                   | a control that lands on the 3:1 line at night             |
| a token has no value in `.dark`                                    | one mode keeping the other mode's colour                  |
| a class paints from a colour your `@theme` never declares          | `text-white` reading right at noon and vanishing at night |

A floor it cannot measure fails too: a value that is not a hex colour (or a `var()` chain to
one) is a floor nobody is keeping. State variants are held to the same token rule, and a
`hover:` that paints the same fill the base already has is a warning, so the state changes
nothing. A class that compiles to no rule at all is a warning as well: a token Tailwind does
not have, or a class built dynamically that no scan can see.

Pass `allow: [/^bg-brand-/]` for the classes a repo means. Floors take no allow list: a
measured ratio is not a judgement call.

## The vite preset

```ts
import { webPreset } from "@gusnips/vite/preset";
import { defineConfig } from "vite";

export default defineConfig(webPreset({ root: import.meta.dirname, port: 5173 }));
```

It adds the React and Tailwind plugins, points `@` at `src`, and runs `vite preview` on the port
minus 1000. `root` is required: it is the folder that holds `index.html`. Its own subpath too,
since it pulls in those two plugins.

Pass more plugins in `plugins`. They run after the preset's own:

```ts
export default defineConfig(
  webPreset({ root: import.meta.dirname, port: 5173, plugins: [themeScript(THEME)] }),
);
```

MIT · part of [kit](https://github.com/gusnips/kit)
