/**
 * The head a crawler sees, baked at build time.
 *
 * A Vite SPA ships one `index.html` and draws everything else with JavaScript. Nothing that
 * reads a link for a living runs that bundle — not Google's first pass, not Bing, not an LLM
 * crawler, not whatever draws the preview card in Slack. So the build rewrites the template
 * once per route and writes a real file per page, with a real `<head>` AND a real body.
 *
 * Pure string work, on purpose: no `node:` import anywhere in this file, so every branch is
 * unit-testable without a filesystem. The reading and writing lives in `node.ts`.
 */
// The `/contract` subpath, not the barrel: the barrel reaches `react-dom/client` through
// `hydrate.ts`, and a build script asking for one string should not pull the browser renderer
// into a Node process. That file imports nothing at all.
import { PRERENDERED_ROUTE_ATTR } from "@gusnips/react/contract";
import { escapeAttr, escapeRegex } from "./escape.ts";

/** The empty root a template must carry. `bakeHead` fills it and refuses a filled one. */
export const EMPTY_ROOT = '<div id="root"></div>';

/**
 * One tag, in BOTH attribute orders.
 *
 * `[^>]*` on either side already tolerates the attributes being split across lines, as Vite
 * emits them. What it cannot tolerate is `content` coming FIRST — `<meta content="…"
 * name="description">` is equally valid HTML, hand-written heads are full of it, and a regex
 * anchored on "selector, then content" simply does not match. That matters more here than
 * anywhere else in this file, because {@link setMeta} THROWS on no match: a template spelling
 * one required tag the other way round is a red build with a misleading message, on a head that
 * is perfectly correct. The fifth adopter's rig carried the reversed form as a second pattern;
 * this is that, kept.
 *
 * The capture groups differ between the two, which is why they are separate patterns and not
 * one alternation: forward captures `(…content=")value(")`, reversed captures
 * `(<meta…content=")value("…selector)`. `$1`/`$2` mean the right thing in both.
 */
const metaResFor = (pattern: string): readonly RegExp[] => [
  new RegExp(`(<meta[^>]*${pattern}[^>]*content=")[^"]*(")`),
  new RegExp(`(<meta[^>]*content=")[^"]*("[^>]*${pattern})`),
];

/** …from a selector written literally, as every caller but {@link eitherRes} writes it. */
const metaRes = (selector: string): readonly RegExp[] => metaResFor(escapeRegex(selector));

/**
 * Rewrite the value the first matching pattern captures between `$1` and `$2`, or null when the
 * template carries no such tag. Tag-agnostic on purpose — the canonical `<link>` uses it too.
 *
 * Every page text in this file goes into `replace` through a FUNCTION, never as the replacement
 * string. A string is read for `$` patterns: `$$` becomes `$`, and `$'` pastes in the rest of the
 * template. One adopter's docs showed a place priced `"$$"`; the file said `"$"`, and React threw
 * on hydration because the page no longer matched its own render.
 */
function rewriteAttr(html: string, patterns: readonly RegExp[], value: string): string | null {
  for (const re of patterns) {
    if (re.test(html))
      return html.replace(re, (_tag, before: string, after: string) => {
        return before + escapeAttr(value) + after;
      });
  }
  return null;
}

/**
 * Replace the `content` of one `<meta …>`. Throws when the tag is missing, so an edit to
 * `index.html` fails the build instead of silently shipping the front door's description to
 * every crawler.
 */
function setMeta(html: string, selector: string, value: string): string {
  const out = rewriteAttr(html, metaRes(selector), value);
  if (out === null) throw new Error(`prerender: <meta ${selector}> not found in index.html`);
  return out;
}

/**
 * The same regex, for a key a template may spell with EITHER attribute.
 *
 * The `twitter:` family is written both ways in the wild and both work: X's own documentation
 * says `name=`, the Open Graph spec says `property=`, and two adopters' templates carry
 * `name="twitter:card"` in the same head as `property="twitter:title"`. Matching one spelling
 * silently skips the other — and these tags go through `setMetaIfPresent`, where "skipped" is
 * not an error but the intended behaviour for a template that does not have them.
 *
 * The fourth adopter spells the whole family `name=`. Baked with the narrow regex, every one of
 * its 45 prerendered files — eleven pages in three languages — would have kept the template's
 * card title and description, which is the front door's, and nothing in a browser shows it.
 * That is the exact failure this file exists to prevent, arriving through the package rather
 * than despite it.
 */
const eitherRes = (key: string): readonly RegExp[] =>
  metaResFor(`(?:name|property)="${escapeRegex(key)}"`);

/**
 * Replace the `content` of a tag a template is allowed not to carry.
 *
 * Only the `twitter:` tags, `og:image:alt` and `name="title"` get this. X reads the `og:` tags when
 * the `twitter:` ones are absent, no crawler reads `name="title"` at all, and most templates carry
 * no image alt — so a template that omits them is correct, and demanding them would break an app
 * that never had them. A template that DOES carry one and gets a stale value is still a bug, which
 * is why they are written rather than ignored. Everything a crawler actually depends on goes
 * through `setMeta`.
 *
 * Takes the patterns rather than the selector, so each caller picks how strict the spelling is.
 */
function setMetaIfPresent(html: string, patterns: readonly RegExp[], value: string): string {
  return rewriteAttr(html, patterns, value) ?? html;
}

/** One `<link rel="alternate" hreflang>` for this page's address in another language. */
export interface Alternate {
  /** A BCP-47 tag, or `x-default` for the address a crawler should show when it has no reason
   *  to prefer one. */
  hreflang: string;
  href: string;
}

export interface HeadTags {
  /** `<title>`, and the share title unless overridden. */
  title: string;
  /** `name="description"`, and the share description unless overridden. */
  description: string;
  /**
   * The page's own URL, for `<link rel="canonical">` and the share tags.
   *
   * `null` means this page has no canonical URL and must not claim one, as with the 404 shell,
   * which is served for every address that does not exist and would otherwise tell a crawler that
   * all of them are the front page.
   */
  canonical: string | null;
  ogTitle?: string;
  ogDescription?: string;
  /** Absolute URL of the share card. Omit where the template carries no `og:image` tag. Setting one there is a build error, by design. */
  image?: string;
  /** Markup inserted before `</head>` for structured data, and nothing else so far. Emitted here
   *  because its only reader is a crawler. */
  headExtra?: string;
  /** Keep this page out of every index. Pairs with `canonical: null`. */
  noindex?: boolean;
  /**
   * `<html lang>`, when this page is not in the template's language, and the `og:locale` that
   * goes with it.
   *
   * A crawler and a screen reader both read `lang`, and neither runs the bundle that would
   * otherwise set it, so a Portuguese file whose `<html>` still says `en` is announced in the wrong
   * voice and indexed as the wrong language.
   */
  lang?: string;
  /**
   * Every language this page exists in, INCLUDING this one, plus `x-default`.
   *
   * Reciprocal by contract: a crawler ignores the whole set unless each address in it points
   * back at the others, which is why the caller passes the full list to every page rather than
   * "the other two".
   */
  alternates?: readonly Alternate[];
  /**
   * The rendered page, injected into `<div id="root">`, and the route it is a render OF.
   *
   * The head alone was never enough. A shipped `<div id="root"></div>` is a page whose entire
   * content is a description tag. It can be listed, and it can never be read, quoted or answered
   * from.
   *
   * The two travel together because markup alone is not enough to hydrate against. A static host
   * answers every unpublished address with the nearest `404.html`, and that file has a rendered
   * body in it, so a route served from the shell would find a full root and hydrate the not-found
   * page into a page that is not it. The marker is what the browser entry compares its own route
   * against before deciding to hydrate or to mount fresh.
   */
  body?: { route: string; html: string };
}

/**
 * A BCP-47 tag in Open Graph's spelling: underscore, and a TERRITORY it will not infer.
 *
 * `og:locale` wants `language_TERRITORY` and quietly ignores anything else, which is the same
 * outcome as omitting it: the `en_US` default. So a Portuguese page with a Portuguese `og:title`
 * and no `og:locale` tells every share crawler the card is English. `pt-BR` already carries its
 * territory; `en` and `es` do not, so one is chosen here rather than left to a crawler. `es_ES` is
 * not a claim that the copy is peninsular Spanish. It is the most widely recognised Spanish value,
 * and the tag's job is to be understood, not precise about dialect.
 */
export function ogLocale(tag: string): string {
  const TERRITORY: Record<string, string> = { en: "en_US", es: "es_ES" };
  return TERRITORY[tag] ?? tag.replace("-", "_");
}

/** One question and its answer, as the page renders them. Pass the same strings, so the
 *  structured data cannot drift from the copy. One donor's template carried four questions
 *  where the page renders seven, and nothing compared them until the migration. */
export interface FaqEntry {
  question: string;
  answer: string;
}

/**
 * Structured data for `headExtra`. The caller owns the schema and its claims.
 *
 * Escape every less-than character as JSON, not HTML: `</script>` can close the element, and
 * `<!--<script>` can make the HTML parser swallow the real closing tag. Escaping only a slash
 * misses that second case; adding a backslash before `!` makes the JSON invalid.
 */
export function jsonLd(data: object): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

/** FAQ structured data from the same strings the page renders. */
export function faqJsonLd(faqs: readonly FaqEntry[]): string {
  return jsonLd({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  });
}

/**
 * One page's `<head>` and body, written into the built template.
 *
 * Every tag is SET rather than appended, and `setMeta` throws on a tag the template does not carry,
 * so the failure mode of editing `index.html` is a red build, never a page quietly shipping
 * somebody else's description.
 */
export function bakeHead(template: string, tags: HeadTags): string {
  const shareTitle = tags.ogTitle ?? tags.title;
  const shareDescription = tags.ogDescription ?? tags.description;

  let html = template.replace(
    /<title>[^<]*<\/title>/,
    () => `<title>${escapeAttr(tags.title)}</title>`,
  );
  html = setMeta(html, 'name="description"', tags.description);
  html = setMeta(html, 'property="og:title"', shareTitle);
  html = setMeta(html, 'property="og:description"', shareDescription);
  html = setMetaIfPresent(html, metaRes('name="title"'), tags.title);
  html = setMetaIfPresent(html, eitherRes("twitter:title"), shareTitle);
  html = setMetaIfPresent(html, eitherRes("twitter:description"), shareDescription);

  if (tags.image !== undefined) {
    html = setMeta(html, 'property="og:image"', tags.image);
    html = setMetaIfPresent(html, eitherRes("twitter:image"), tags.image);
    // A card's description goes with the card. Left alone, every page's own card was described
    // with the front page's title — the stale value this function exists to prevent, on the one
    // tag written for somebody who cannot see the picture.
    html = setMetaIfPresent(html, eitherRes("og:image:alt"), shareTitle);
  }

  if (tags.canonical === null) {
    // Strip rather than blank: an empty canonical is a claim about "" and an empty og:url is a
    // share card pointing at the origin root. The image is left alone — it is a picture, not a
    // claim about this address, and a dead link that still unfurls the brand card is fine.
    html = html
      .replace(/\s*<link[^>]*rel="canonical"[^>]*>/, "")
      .replace(/\s*<meta[^>]*(?:name|property)="(?:og|twitter):url"[^>]*>/g, "");
  } else {
    html = setMeta(html, 'property="og:url"', tags.canonical);
    html = setMetaIfPresent(html, eitherRes("twitter:url"), tags.canonical);
    // Demanded, like every meta tag a crawler depends on. `String.replace` with no match is a
    // silent no-op, so a template that never had a canonical would get one on no page at all
    // and say nothing about it — the exact failure `setMeta` exists to turn into a red build.
    // Both attribute orders, for the reason `metaResFor` gives — and this is the branch where
    // getting it wrong REFUSES a correct head rather than skipping it.
    const written = rewriteAttr(
      html,
      [
        /(<link[^>]*rel="canonical"[^>]*href=")[^"]*(")/,
        /(<link[^>]*href=")[^"]*("[^>]*rel="canonical")/,
      ],
      tags.canonical,
    );
    if (written === null)
      throw new Error('prerender: <link rel="canonical"> not found in index.html');
    html = written;
  }

  if (tags.alternates?.length) {
    const links = tags.alternates
      .map(
        (alt) =>
          `    <link rel="alternate" hreflang="${escapeAttr(alt.hreflang)}" href="${escapeAttr(alt.href)}" />`,
      )
      .join("\n");
    html = html.replace("</head>", () => `${links}\n  </head>`);
  }

  if (tags.lang !== undefined) {
    // `og:locale` is not the same claim as `<html lang>` and is read by different machines.
    // APPENDED rather than set, because a Vite template carries no such tag — but one that
    // does would end up with two, and a crawler reading the first would get the template's
    // language on every page. So drop whatever is there before writing this page's own.
    // `[^>]*` before the attribute as well as after it: a template that writes `content` first
    // would survive the strip and keep its own tag beside the appended one, and a crawler
    // reading the first of two gets the template's language on every page — which is the exact
    // outcome the strip is here to prevent.
    html = html.replace(/\s*<meta[^>]*property="og:locale(?::alternate)?"[^>]*>/g, "");
    const alternates = (tags.alternates ?? [])
      .filter((alt) => alt.hreflang !== "x-default" && alt.hreflang !== tags.lang)
      .map(
        (alt) =>
          `    <meta property="og:locale:alternate" content="${escapeAttr(ogLocale(alt.hreflang))}" />`,
      );
    const locale = escapeAttr(ogLocale(tags.lang));
    html = html.replace(
      "</head>",
      () =>
        `    <meta property="og:locale" content="${locale}" />\n${
          alternates.length ? `${alternates.join("\n")}\n` : ""
        }  </head>`,
    );
  }

  // A template that says `index, follow` gets its tag rewritten, not a second one beside it. A head
  // carrying both leaves a contradiction to each crawler's own tie-break rule, and one adopter's
  // 404 shipped exactly that.
  if (tags.noindex) {
    html =
      rewriteAttr(html, metaRes('name="robots"'), "noindex") ??
      html.replace("</head>", `    <meta name="robots" content="noindex" />\n  </head>`);
  }
  const { headExtra } = tags;
  if (headExtra) html = html.replace("</head>", () => `    ${headExtra}\n  </head>`);

  if (tags.lang !== undefined) {
    const re = /(<html[^>]*\blang=")[^"]*(")/;
    if (!re.test(html)) throw new Error("prerender: <html lang> not found in index.html");
    const lang = escapeAttr(tags.lang);
    html = html.replace(re, (_tag, before: string, after: string) => before + lang + after);
  }

  if (tags.body !== undefined) {
    // Empty on purpose in the template, and it must STAY empty there: a second bake over an
    // already-filled root would nest one render inside another.
    if (!html.includes(EMPTY_ROOT))
      throw new Error(`prerender: ${EMPTY_ROOT} not found in index.html`);
    const { route, html: page } = tags.body;
    html = html.replace(
      EMPTY_ROOT,
      () => `<div id="root" ${PRERENDERED_ROUTE_ATTR}="${escapeAttr(route)}">${page}</div>`,
    );
  }

  return html;
}

export interface RenderedChecks {
  /** The BCP-47 tag this file must be marked with. Pass the same `lang` to `bakeHead`. */
  lang?: string;
  /** Bytes the page must have gained over the template before it counts as rendered.
   *  500 is the floor both donor builds ran with. */
  minGrowth?: number;
}

/**
 * Past this much growth the file has a page in it, whatever else it also contains.
 *
 * It is what lets the loading-screen search below look at a whole slice rather than one tag: a
 * real page that opens with a live region ("Saved", a connection banner) is far over this, and a
 * splash never is. The donor's was 1,174 bytes.
 */
const SPLASH_MAX_GROWTH = 2000;

/**
 * React's own words when `renderToString` meets a Suspense boundary it cannot render.
 *
 * Matched in both spellings because the quotes are escaped by the time the markup reaches a file,
 * and matched as the WHOLE sentence rather than a memorable fragment of it: the page that exposed
 * this was a documentation site, and "does not support Suspense" is a phrase a React guide may
 * legitimately print. This one nobody writes on purpose.
 */
const RENDERER_ERROR =
  /The server used (?:"|&quot;)renderToString(?:"|&quot;) which does not support Suspense/;

/**
 * What every written file must be true of before the build is allowed to pass.
 *
 * The regression this exists for is a root that renders to nothing. A router whose location does
 * not match its routes yields empty markup with no error and no warning. It looks fine in every
 * browser and is invisible to everything that reads a link. Checking the bytes we actually wrote is
 * the only thing that catches it, and it needs no browser, so it gates the BUILD rather than
 * sitting in a test suite.
 *
 * The loading-screen check is the half a size floor misses. With `lazy()` routes behind one
 * `<Suspense fallback={<Spinner />}>`, a render that resolves nothing still produces a
 * plausible body: one donor shipped a 1,174-byte spinner with a perfect title and an element
 * inside the root. A file whose body is a spinner is WORSE than an empty one, because every
 * cheap check passes.
 */
export function assertRendered(
  file: string,
  html: string,
  template: string,
  checks: RenderedChecks = {},
): void {
  function fail(why: string): never {
    throw new Error(`prerender: ${file} ${why}`);
  }

  // Measured against the template rather than by matching the root's closing tag — the body is
  // thousands of nested `</div>`s and no regex should be asked to find the right one.
  // Everything this file has over the shell it was baked from is the page.
  const floor = checks.minGrowth ?? 500;
  const grew = html.length - template.length;
  // The floor goes in the message, because the other reading is a page that is short on purpose:
  // a guide's reader built a 396-byte pricing page and was told nothing rendered.
  if (grew < floor)
    fail(
      `is only ${String(grew)} bytes bigger than the shell, under the ${String(floor)}-byte floor. ` +
        "Either nothing rendered, or the page is short on purpose: pass `{ minGrowth }` to lower it.",
    );
  if (/<title>\s*<\/title>/.test(html)) fail("has an empty <title>");
  if (checks.lang !== undefined && !html.includes(`<html lang="${checks.lang}"`))
    fail(`is not marked as ${checks.lang}`);

  // A `%NAME%` the HTML transform never filled in. Three inner characters minimum, because two
  // is the shape of percent-encoding: `/caf%C3%A9` contains `%C3%`, and an accented slug is not
  // a broken build.
  const placeholder = /%[A-Z][A-Z0-9_]{2,}%/.exec(html);
  if (placeholder) fail(`still carries an unsubstituted placeholder, ${placeholder[0]}`);

  // `renderToString` does not only render the fallback at a boundary it cannot handle — it can
  // write its own ERROR into the markup, stack trace and all, including absolute paths from the
  // machine that ran the build. The eighth migration found exactly that on a live, indexed page,
  // and in only ONE of its two languages: the first render bails but also resolves the `lazy()`
  // promise, so the next locale in the same loop rendered the real component and looked perfect.
  // Checked against the whole document and NOT gated on size, because the error text makes the
  // file bigger — which is why every other check here waves it through.
  if (RENDERER_ERROR.test(html))
    fail(
      "carries React's renderToString error where its page should be. The entry is still on " +
        "`renderToString`, which cannot render a Suspense boundary and writes the failure into " +
        "the file instead. Render with `renderTree` from @gusnips/vite/render, which waits for " +
        "every `lazy()` page.",
    );

  // What the root ACTUALLY opens with. Sliced rather than matched in one pattern, because a
  // regex that skips React's `<!--$-->` Suspense markers with `(?:<!--.*?-->|\s)*` can backtrack
  // across the whole document — it will happily skip 40 KB of real page to find a
  // `role="status"` further down and report a perfectly good file as a spinner. It did exactly
  // that in the donor before this was rewritten as a slice.
  const opened = /<div id="root"[^>]*>/.exec(html);
  if (!opened) fail("has no root element at all");
  const start = opened.index + opened[0].length;
  const head = html
    .slice(start, start + 600)
    .replace(/<!--.*?-->/g, "")
    .trimStart();

  if (!/^<[a-z]/.test(head)) fail("has no element inside its root");
  // Anywhere in that bounded slice, not only its first tag, and only while the file is small
  // enough to BE a splash. Anchored at the root's first element this missed the fourth adopter's
  // loading screen, which centres its live region inside a `<main>` — one element deeper than the
  // donor's, and an ordinary-looking wrapper to a test that reads one tag. That adopter's own
  // guard missed it from the other side: it failed a file containing a spinner class its splash
  // does not use. Two checks written for one regression, neither of which could ever fire.
  if (grew < SPLASH_MAX_GROWTH && head.includes('role="status"'))
    fail("rendered the loading screen, not the page. Something suspended and never resolved");
}
