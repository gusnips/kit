import { describe, expect, it } from "vitest";
import { PRERENDERED_ROUTE_ATTR } from "@gusnips/react";
import { assertRendered, bakeHead, faqJsonLd, jsonLd, ogLocale } from "./head.ts";

/**
 * Every failure `bakeHead` has is invisible until somebody reads a search result months later
 * — a canonical that survived onto a 404, an `og:locale` still claiming English on a Portuguese
 * file, a body that never went in. `assertRendered` checks a written page as a whole; this
 * checks the branches it cannot see the inside of.
 */

/** A template carrying the full donor tag set: OG, Twitter, and the `name="title"` two of the
 *  three donors ship. */
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <title>front</title>
    <meta name="title" content="front" />
    <meta name="description" content="front" />
    <link rel="canonical" href="https://acme.com/" />
    <meta property="og:title" content="front" />
    <meta property="og:description" content="front" />
    <meta property="og:url" content="https://acme.com/" />
    <meta property="og:image" content="https://acme.com/og.png" />
    <meta property="twitter:title" content="front" />
    <meta property="twitter:description" content="front" />
    <meta property="twitter:url" content="https://acme.com/" />
    <meta property="twitter:image" content="https://acme.com/og.png" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

/** The leaner set a third donor ships: no `name="title"`, no `twitter:` pair. */
const LEAN_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <title>front</title>
    <meta name="description" content="front" />
    <link rel="canonical" href="https://acme.com/" />
    <meta property="og:title" content="front" />
    <meta property="og:description" content="front" />
    <meta property="og:url" content="https://acme.com/" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

/**
 * A fourth adopter's spelling of the same tags. X's own documentation writes them `name=`, the
 * Open Graph spec writes `property=`, and crawlers read both — so a template may use either, and
 * two templates in this fleet use both in one head. Matching only `property=` turned the other
 * spelling into a silent skip rather than a build error.
 */
const NAME_TWITTER_TEMPLATE = TEMPLATE.replace(/property="twitter:/g, 'name="twitter:');

/**
 * The same head with `content` written FIRST, on every tag including the canonical.
 *
 * Equally valid HTML, ordinary in a hand-written template, and the fifth adopter's own rig
 * carried a second pattern for exactly this. Here it is worse than the spelling above: the
 * narrow regex did not merely skip these tags, it made `setMeta` THROW — so a correct head
 * failed the build saying the tag was "not found in index.html".
 */
const CONTENT_FIRST_TEMPLATE = TEMPLATE.replace(
  /<meta ((?:name|property)="[^"]*") (content="[^"]*")/g,
  "<meta $2 $1",
).replace(
  '<link rel="canonical" href="https://acme.com/" />',
  '<link href="https://acme.com/" rel="canonical" />',
);

const BASE = { title: "T", description: "D", canonical: "https://acme.com/pricing" };

describe("bakeHead", () => {
  it("writes the page's own title, description and share text", () => {
    const html = bakeHead(TEMPLATE, { ...BASE, ogTitle: "share", ogDescription: "sub" });
    expect(html).toContain("<title>T</title>");
    expect(html).toContain('<meta name="description" content="D" />');
    expect(html).toContain('<meta property="og:title" content="share" />');
    expect(html).toContain('<meta property="twitter:description" content="sub" />');
    expect(html).toContain('<link rel="canonical" href="https://acme.com/pricing" />');
    expect(html).toContain('<meta property="og:url" content="https://acme.com/pricing" />');
  });

  it("falls back to the page's own words for the share tags", () => {
    const html = bakeHead(TEMPLATE, BASE);
    expect(html).toContain('<meta property="og:title" content="T" />');
    expect(html).toContain('<meta property="twitter:title" content="T" />');
  });

  it("escapes what it writes into an attribute", () => {
    const html = bakeHead(TEMPLATE, { ...BASE, description: 'a "quote" & <tag>' });
    expect(html).toContain('content="a &quot;quote&quot; &amp; &lt;tag&gt;"');
  });

  // The whole reason `setMeta` throws: editing index.html must fail the build, never ship a
  // page quietly wearing the front door's description.
  it("refuses a template missing a tag a crawler depends on", () => {
    const stripped = TEMPLATE.replace(/<meta property="og:title"[^>]*>/, "");
    expect(() => bakeHead(stripped, BASE)).toThrow(/og:title/);
  });

  // The canonical is a `<link>`, so it is written with `String.replace` rather than `setMeta` —
  // and a replace that matches nothing succeeds silently. Without this, a template that never
  // carried a canonical would ship every page without one and say nothing.
  it("refuses a template with no canonical to write into", () => {
    const stripped = TEMPLATE.replace(/<link rel="canonical"[^>]*>/, "");
    expect(() => bakeHead(stripped, BASE)).toThrow(/canonical/);
  });

  // …and the exception: nothing reads `name="title"`, and X reads `og:` when `twitter:` is
  // absent. A template without them is correct, so demanding them would break a real app.
  it("skips the optional tags a template does not carry", () => {
    const html = bakeHead(LEAN_TEMPLATE, BASE);
    expect(html).toContain('<meta property="og:title" content="T" />');
    expect(html).not.toContain("twitter:");
    expect(html).not.toContain('name="title"');
  });

  // …and the trap right beside that exception. A template that DOES carry these, spelled the
  // way X documents them, must not read as one that omits them: skipping is correct for an
  // absent tag and silent data loss for a present one. An adopter on this spelling would have
  // shipped every page wearing the front door's card.
  it("writes the share tags whichever attribute the template spells them with", () => {
    const html = bakeHead(NAME_TWITTER_TEMPLATE, { ...BASE, ogTitle: "share" });
    expect(html).toContain('<meta name="twitter:title" content="share" />');
    expect(html).toContain('<meta name="twitter:description" content="D" />');
  });

  // The other half of the same class, and the louder one: a required tag written the other way
  // round was a red build on a head that is perfectly correct.
  it("writes a head that spells the content attribute first", () => {
    const html = bakeHead(CONTENT_FIRST_TEMPLATE, { ...BASE, ogTitle: "share" });
    expect(html).toContain('<meta content="D" name="description" />');
    expect(html).toContain('<meta content="share" property="og:title" />');
    expect(html).toContain('<meta content="share" property="twitter:title" />');
    expect(html).toContain('<link href="https://acme.com/pricing" rel="canonical" />');
  });

  it("strips a reversed canonical and share URL from a shell", () => {
    const html = bakeHead(CONTENT_FIRST_TEMPLATE, { ...BASE, canonical: null });
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain("og:url");
    expect(html).not.toContain('content=""');
  });

  // Strip-then-append, so a strip that misses leaves two tags — and a crawler reads the first,
  // which is the template's language rather than this page's.
  it("replaces a reversed og:locale instead of writing a second one", () => {
    const withLocale = CONTENT_FIRST_TEMPLATE.replace(
      "</head>",
      '  <meta content="en_US" property="og:locale" />\n  </head>',
    );
    const html = bakeHead(withLocale, { ...BASE, lang: "pt-BR" });
    expect(html.match(/property="og:locale"/g)).toHaveLength(1);
    expect(html).toContain('content="pt_BR"');
  });

  it("strips a share URL spelled with either attribute", () => {
    const html = bakeHead(NAME_TWITTER_TEMPLATE, { ...BASE, canonical: null });
    expect(html).not.toContain("twitter:url");
    expect(html).not.toContain('content=""');
  });

  it("strips the canonical and the share URL rather than blanking them", () => {
    const html = bakeHead(TEMPLATE, { ...BASE, canonical: null, noindex: true });
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('property="og:url"');
    expect(html).not.toContain('property="twitter:url"');
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });

  it("rewrites the template's own robots tag rather than contradicting it", () => {
    const indexable = TEMPLATE.replace(
      "</head>",
      '<meta name="robots" content="index, follow" />\n</head>',
    );
    const html = bakeHead(indexable, { ...BASE, canonical: null, noindex: true });
    expect(html.match(/name="robots"/g)).toHaveLength(1);
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });

  // An empty canonical is a claim about "" and an empty og:url is a share card pointing at the
  // origin root, which is what the strip exists to avoid.
  it("leaves no blank URL behind on a page with no canonical", () => {
    const html = bakeHead(TEMPLATE, { ...BASE, canonical: null });
    expect(html).not.toContain('href=""');
    expect(html).not.toContain('content=""');
  });

  // The card is a picture, not a claim about this address: a dead link that still unfurls the
  // brand card is fine, and a 404 with no image at all is not better.
  it("keeps the share card on a page with no canonical", () => {
    const html = bakeHead(TEMPLATE, { ...BASE, canonical: null });
    expect(html).toContain('<meta property="og:image" content="https://acme.com/og.png" />');
  });

  // Left alone, every page's card was described as the front page's card.
  it("describes the page's own card, and leaves the brand card's description with it", () => {
    const withAlt = TEMPLATE.replace(
      "</head>",
      '  <meta property="og:image:alt" content="front" />\n  </head>',
    );
    const page = bakeHead(withAlt, { ...BASE, image: "https://acme.com/og/pricing.png" });
    expect(page).toContain('<meta property="og:image:alt" content="T" />');
    const shell = bakeHead(withAlt, { ...BASE, canonical: null });
    expect(shell).toContain('<meta property="og:image:alt" content="front" />');
  });

  it("lists every alternate, reciprocally, including this page's own", () => {
    const html = bakeHead(TEMPLATE, {
      ...BASE,
      alternates: [
        { hreflang: "en", href: "https://acme.com/pricing" },
        { hreflang: "pt-BR", href: "https://acme.com/pt/pricing" },
        { hreflang: "x-default", href: "https://acme.com/pricing" },
      ],
    });
    expect(html.match(/rel="alternate"/g)).toHaveLength(3);
    expect(html).toContain('hreflang="pt-BR" href="https://acme.com/pt/pricing"');
  });

  it("marks the file's own language for a crawler and a screen reader", () => {
    const html = bakeHead(TEMPLATE, { ...BASE, lang: "pt-BR" });
    expect(html).toContain('<html lang="pt-BR">');
  });

  it("refuses a template whose <html> has no lang to rewrite", () => {
    const stripped = TEMPLATE.replace('<html lang="en">', "<html>");
    expect(() => bakeHead(stripped, { ...BASE, lang: "pt-BR" })).toThrow(/<html lang>/);
  });

  // Invariant 6: absent, `og:locale` does not default to "unknown" — it defaults to en_US, so
  // a Portuguese page with a Portuguese og:title told every share crawler the card was English.
  it("states og:locale, and the other languages the page exists in", () => {
    const html = bakeHead(TEMPLATE, {
      ...BASE,
      lang: "pt-BR",
      alternates: [
        { hreflang: "en", href: "https://acme.com/pricing" },
        { hreflang: "pt-BR", href: "https://acme.com/pt/pricing" },
        { hreflang: "x-default", href: "https://acme.com/pricing" },
      ],
    });
    expect(html).toContain('<meta property="og:locale" content="pt_BR" />');
    expect(html).toContain('<meta property="og:locale:alternate" content="en_US" />');
    // Not itself, and not x-default — neither is another language this page exists in.
    expect(html.match(/og:locale:alternate/g)).toHaveLength(1);
  });

  // A template that already carries one would otherwise end up with two, and a crawler reading
  // the first would get the template's language on every page.
  it("replaces an og:locale the template already carries", () => {
    const withLocale = TEMPLATE.replace(
      "</head>",
      '  <meta property="og:locale" content="en_US" />\n  </head>',
    );
    const html = bakeHead(withLocale, { ...BASE, lang: "pt-BR" });
    expect(html.match(/property="og:locale"/g)).toHaveLength(1);
    expect(html).toContain('content="pt_BR"');
  });

  it("puts the render inside the root and names the route it is a render of", () => {
    const html = bakeHead(TEMPLATE, {
      ...BASE,
      body: { route: "/pricing", html: "<main>hi</main>" },
    });
    expect(html).toContain(
      `<div id="root" ${PRERENDERED_ROUTE_ATTR}="/pricing"><main>hi</main></div>`,
    );
  });

  it("writes a page's dollar signs as they are, in every field that takes page text", () => {
    // A replacement STRING reads `$$` as `$` and `$'` as the rest of the template. One adopter's
    // docs priced a place `"$$"`, the file said `"$"`, and hydration threw.
    const money = "$$ $& $' $` $1";
    const html = bakeHead(TEMPLATE, {
      title: money,
      description: money,
      canonical: `https://acme.com/${money}`,
      image: `https://acme.com/${money}.png`,
      lang: "pt-BR",
      alternates: [{ hreflang: "en", href: `https://acme.com/en/${money}` }],
      headExtra: `<script type="application/ld+json">{"priceRange":"${money}"}</script>`,
      body: { route: "/", html: `<p>${money}</p>` },
    });
    const escaped = "$$ $&amp; $' $` $1";
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<meta name="description" content="${escaped}" />`);
    expect(html).toContain(`<link rel="canonical" href="https://acme.com/${escaped}" />`);
    expect(html).toContain(`content="https://acme.com/${escaped}.png"`);
    expect(html).toContain(`href="https://acme.com/en/${escaped}"`);
    expect(html).toContain(`{"priceRange":"${money}"}`);
    expect(html).toContain(`<p>${money}</p></div>`);
    expect(html.match(/<\/html>/g)).toHaveLength(1);
  });

  it("refuses to bake a page into a page", () => {
    const once = bakeHead(TEMPLATE, { ...BASE, body: { route: "/", html: "<main>hi</main>" } });
    expect(() =>
      bakeHead(once, { ...BASE, body: { route: "/x", html: "<main>x</main>" } }),
    ).toThrow(/root/);
  });

  it("carries structured data through untouched", () => {
    const html = bakeHead(TEMPLATE, {
      ...BASE,
      headExtra: '<script type="application/ld+json">{"@type":"FAQPage"}</script>',
    });
    expect(html).toContain('<script type="application/ld+json">{"@type":"FAQPage"}</script>');
  });
});

describe("ogLocale", () => {
  it("gives en and es the territory Open Graph will not infer", () => {
    expect(ogLocale("en")).toBe("en_US");
    expect(ogLocale("es")).toBe("es_ES");
  });

  it("respells a tag that already carries its territory", () => {
    expect(ogLocale("pt-BR")).toBe("pt_BR");
  });
});

describe("assertRendered", () => {
  const shell = `<html lang="en"><head><title>T</title></head><body><div id="root"></div></body></html>`;
  const page = (body: string): string => shell.replace('<div id="root"></div>', body);
  const long = `<main>${"x".repeat(800)}</main>`;

  it("passes a page with a real body in it", () => {
    expect(() =>
      assertRendered("pricing.html", page(`<div id="root">${long}</div>`), shell),
    ).not.toThrow();
  });

  // Invariant 1: a router whose basename does not match its location renders "" with no error
  // and no warning. Only the bytes catch it.
  it("catches a root that rendered to nothing", () => {
    expect(() => assertRendered("pricing.html", shell, shell)).toThrow(/nothing rendered/);
  });

  // A short page is the other reading of the same number, so the refusal names the floor and the
  // way past it. A guide's reader hit this with a real 396-byte page and a message that said
  // nothing rendered.
  it("names the floor, and lets a short page lower it", () => {
    const short = page(`<div id="root"><main>${"x".repeat(396)}</main></div>`);
    expect(() => assertRendered("pricing.html", short, shell)).toThrow(
      /under the 500-byte floor.*minGrowth/,
    );
    expect(() => assertRendered("pricing.html", short, shell, { minGrowth: 200 })).not.toThrow();
  });

  // The size floor is not enough, and a donor proved it: a route rendered its LoadingScreen at
  // 1,174 bytes, comfortably over the floor, with an element inside the root and a good title.
  it("catches a file whose body is the loading screen", () => {
    const spinner = `<div id="root"><div role="status" aria-label="Loading">${"x".repeat(800)}</div></div>`;
    expect(() => assertRendered("pricing.html", page(spinner), shell)).toThrow(/loading screen/);
  });

  // The donor's splash IS the root's first element. A fourth adopter's centres the live region
  // inside a `<main>`, so a check anchored at the first tag saw an ordinary wrapper and passed
  // the file — while that repo's own guard looked for a spinner class its splash does not use.
  it("catches a loading screen nested inside a wrapper element", () => {
    const nested = `<div id="root"><main class="grid place-items-center"><p role="status">Loading${"x".repeat(700)}</p></main></div>`;
    expect(() => assertRendered("pricing.html", page(nested), shell)).toThrow(/loading screen/);
  });

  // What makes the wider search safe: a page with this much in it has a page in it, whatever a
  // live region at the top of it says. A real banner ("Saved", a connection notice) is ordinary.
  it("does not flag a full page that opens with a live region", () => {
    const banner = `<div id="root"><div role="status">Saved</div><main>${"x".repeat(2500)}</main></div>`;
    expect(() => assertRendered("pricing.html", page(banner), shell)).not.toThrow();
  });

  // The reason the check slices rather than matching in one pattern: a regex that skips
  // Suspense markers can backtrack across the whole document and find a `role="status"` 40 KB
  // down in a perfectly good page.
  it("does not mistake a status role deep in a real page for a spinner", () => {
    const deep = `<div id="root"><main>${"x".repeat(2000)}<div role="status">saved</div></main></div>`;
    expect(() => assertRendered("pricing.html", page(deep), shell)).not.toThrow();
  });

  it("sees past React's Suspense comment markers", () => {
    const suspended = `<div id="root"><!--$--><main>${"x".repeat(800)}</main><!--/$--></div>`;
    expect(() => assertRendered("pricing.html", page(suspended), shell)).not.toThrow();
  });

  it("catches an unsubstituted html placeholder", () => {
    const raw = page(`<div id="root"><main>%BRAND_NAME% ${"x".repeat(800)}</main></div>`);
    expect(() => assertRendered("pricing.html", raw, shell)).toThrow(/%BRAND_NAME%/);
  });

  // `/caf%C3%A9` contains `%C3%`, and an accented slug is not a broken build.
  it("does not mistake a percent-encoded link for a placeholder", () => {
    const link = `<div id="root"><main><a href="/caf%C3%A9">x</a>${"x".repeat(800)}</main></div>`;
    expect(() => assertRendered("pricing.html", page(link), shell)).not.toThrow();
  });

  // The eighth migration's finding, in the exact shape it shipped: `renderToString` writing its
  // own failure into a live, indexed page — quotes already escaped, the build machine's absolute
  // paths in the trace. Every other check here passes it, because the error text makes the file
  // BIGGER rather than smaller.
  it("catches React's renderToString error baked into the body", () => {
    const leaked =
      `<div id="root"><main>The server used &quot;renderToString&quot; which does not support ` +
      `Suspense. If you intended for this Suspense boundary to render the fallback content on the ` +
      `server consider throwing an Error somewhere within the Suspense boundary. at Lazy ` +
      `(&lt;anonymous&gt;) at RenderedRoute (/Users/someone/repo/node_modules/react-router/x.js:1:1)` +
      `${"x".repeat(400)}</main></div>`;
    expect(() => assertRendered("api.html", page(leaked), shell)).toThrow(
      /renderToString error.*renderTree` from @gusnips\/vite\/render/,
    );
  });

  // The page that exposed this was a DOCUMENTATION site, which is why the pattern is React's whole
  // sentence and not a memorable fragment of it: a guide is allowed to write about Suspense, and
  // failing its build for saying the words would be a worse bug than the one being caught.
  it("does not flag a guide that writes about Suspense", () => {
    const guide =
      `<div id="root"><main><p>renderToString does not support Suspense, which is why this build ` +
      `uses renderTree instead.</p>${"x".repeat(800)}</main></div>`;
    expect(() => assertRendered("guides/ssr.html", page(guide), shell)).not.toThrow();
  });

  it("catches a file that is not marked as the language it was baked for", () => {
    const html = page(`<div id="root">${long}</div>`);
    expect(() => assertRendered("pt/pricing.html", html, shell, { lang: "pt-BR" })).toThrow(
      /not marked as pt-BR/,
    );
  });
});

describe("jsonLd", () => {
  it("keeps the caller's schema and fields", () => {
    const data = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "SoftwareApplication",
          name: "Example",
          applicationCategory: "DeveloperApplication",
        },
        { "@type": "WebAPI", name: "Example API", documentation: "https://example.com/docs" },
      ],
    };
    const script = jsonLd(data);
    expect(script.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(JSON.parse(script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""))).toEqual(
      data,
    );
  });

  it("round-trips HTML parser control text without exposing markup", () => {
    const data = { name: '</ScRiPt><img src=x onerror="x"> <!-- <script> $$ \\u003c' };
    const script = jsonLd(data);
    const inner = script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    expect(inner).not.toContain("<");
    expect(JSON.parse(inner)).toEqual(data);
    expect(script.match(/<script/g)).toHaveLength(1);
    expect(script.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("faqJsonLd", () => {
  // One donor's template carried four questions where the page renders seven: the fix is to
  // generate the block from the same strings, not to keep a second copy beside them.
  it("writes one Question per entry, with the page's own strings", () => {
    const script = faqJsonLd([
      { question: "Can my number get banned?", answer: "Yes, if you spam." },
      { question: "Is there a free plan?", answer: "Yes." },
    ]);
    expect(script.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(script).toContain('"@type":"FAQPage"');
    expect(script).toContain('"name":"Can my number get banned?"');
    expect(script).toContain('"text":"Yes, if you spam."');
    expect(script.match(/"@type":"Question"/g)).toHaveLength(2);
  });

  it("escapes a script-closing sequence inside an answer", () => {
    const script = faqJsonLd([
      { question: "What if I write code?", answer: "Wrap it: </script> ends the block." },
    ]);
    expect(script).not.toContain("</script> ends");
    expect(script).toContain("\\u003c/script> ends");
    const json = script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    const parsed = JSON.parse(json) as {
      mainEntity: Array<{ acceptedAnswer: { text: string } }>;
    };
    expect(parsed.mainEntity[0]?.acceptedAnswer.text).toBe("Wrap it: </script> ends the block.");
  });

  it("keeps comments valid JSON and inert to the HTML parser", () => {
    const answer = "a </b> b <!-- <script> c";
    const script = faqJsonLd([{ question: "q", answer }]);
    const inner = script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    expect(inner).not.toContain("<");
    expect(JSON.parse(inner)).toMatchObject({
      mainEntity: [{ acceptedAnswer: { text: answer } }],
    });
  });
});
