/**
 * The whole filesystem surface of this package: read the template, load the SSR bundle, write
 * files.
 *
 * It is one file on purpose. Everything else here is string work that a test can run without a
 * disk, and keeping the four impure functions together is what lets `head.ts`, `sitemap.ts`,
 * `render.ts` and `og.ts` stay that way.
 *
 * The prerender LOOP is not here. Every donor's loop is different — one walks a registry once,
 * another walks it per locale, a third writes three separate shells — and all of that is
 * policy the product owns. What is identical in every one of them is these four functions and
 * the gate in `assertRendered`, so those ship and the ~40-line loop stays in the app.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { EMPTY_ROOT } from "./head.ts";
import type { OgOverflow } from "./og.ts";
import { describeOverflow } from "./og.ts";
import type { PageRenderer } from "./render.ts";
import { siteOrigin } from "./sitemap.ts";

/**
 * The built `index.html`, and a refusal to bake one twice.
 *
 * `dist/index.html` is BOTH the template and the front page's destination, so a second run over
 * a `dist/` the prerender has already touched would read a finished page as its blank shell and
 * nest one render inside another. `vite build` empties `dist/` and normally makes this
 * impossible; what does not is a restored build cache, or somebody running the script directly
 * to debug it. Caught here, by name, rather than as a missing-root error three frames down.
 */
export async function loadTemplate(distDir: string): Promise<string> {
  const file = join(distDir, "index.html");
  const template = await readFile(file, "utf8");
  if (!template.includes(EMPTY_ROOT))
    throw new Error(
      `prerender: ${file} does not carry ${EMPTY_ROOT}. Either it is already a rendered page ` +
        "(run `vite build` to regenerate the shell this reads), or the app's root element " +
        "carries attributes, which the baker cannot fill.",
    );
  return template;
}

function exportsRenderer<Context>(mod: unknown): mod is { renderPage: PageRenderer<Context> } {
  return (
    typeof mod === "object" &&
    mod !== null &&
    "renderPage" in mod &&
    typeof mod.renderPage === "function"
  );
}

/**
 * The app compiled for the server, imported out of the BUILT bundle.
 *
 * The prerender is a script rather than a Vite plugin for exactly this reason: it needs the SSR
 * bundle, and a plugin running in `closeBundle` is inside the build that would have to have
 * produced it. So the entry is a path on disk, written by `vite build --ssr src/entry-server.tsx`,
 * and nothing in the source tree references it.
 *
 * **The calling script has to exit itself.** This import is where the renderer enters your process,
 * and under bun `react-dom/static.browser`, which invariant 1 requires every app on this rig to
 * load, leaves that process alive after its last await. Measured by elimination with no app code at
 * all: `react-dom/server` exits, `static.browser` does not, and `process.getActiveResourcesInfo()`
 * reports nothing either way, so the handle is invisible to everything except the hang. Node 26
 * does the same with react-dom 19.3 (measured 2026-10-19). Nothing here can undo it, because a
 * library must not call `process.exit` on its host. A
 * prerender script ends with `process.exit(0)` once every file is written, and in CI the
 * alternative is a job that does all its work and then runs to its timeout. Five adopters had
 * already written that line against a DIFFERENT holder (an auth client whose token-refresh timer
 * starts at module scope); none of them knew the renderer does it too.
 */
export async function loadRenderer<Context = unknown>(
  entryFile: string,
): Promise<PageRenderer<Context>> {
  const mod: unknown = await import(pathToFileURL(entryFile).href);
  if (!exportsRenderer<Context>(mod))
    throw new Error(
      `prerender: ${entryFile} does not export renderPage. Run \`vite build --ssr\` first`,
    );
  return mod.renderPage;
}

/** Write one file under `dist`, creating the folders a nested route needs. */
export async function writeDist(distDir: string, file: string, contents: string): Promise<void> {
  const target = join(distDir, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

/** One laid-out share card: the bytes, and anything that did not fit. */
export interface OgCard {
  png: Uint8Array;
  /** Copy the layout could not hold. A single one refuses the whole run. See {@link writeOgCards}. */
  overflow?: readonly OgOverflow[];
}

export interface WriteOgCardsOptions<Page> {
  pages: readonly Page[];
  /** Where the cards land. Both donors use `public/og`, so they are committed beside the
   *  favicons and served as static files. */
  outDir: string;
  /** The file name for one page, inside `outDir`. `(page) => \`${pageSlug(page.path)}.png\``. */
  file: (page: Page) => string;
  /** Lay one card out and rasterize it. The card's art is the product's; this only drives it. */
  card: (page: Page) => OgCard | Promise<OgCard>;
  /** Lay every card out and report, without writing anything. */
  check?: boolean;
}

/**
 * Walk a page registry and write one share card per page.
 *
 * Every card is laid out BEFORE any is written, and a single line that does not fit refuses the
 * whole run. That order is the point: a card that cannot hold its copy is a product decision, not
 * something to resolve with an ellipsis. An ellipsis makes every string "fit", so overgrown copy
 * has no failing case and ships a card missing the end of the one line the card exists to carry.
 * The reader who finds out is someone else's link unfurl.
 *
 * Overflow is collected rather than thrown on the first card, so one run names every bad one:
 * copy lands per locale in batches, and a build that dies on the first of six sends its
 * operator round the loop six times.
 */
export async function writeOgCards<Page>({
  pages,
  outDir,
  file,
  card,
  check = false,
}: WriteOgCardsOptions<Page>): Promise<string[]> {
  const laid: { file: string; png: Uint8Array }[] = [];
  const overflows: OgOverflow[] = [];

  for (const page of pages) {
    const { png, overflow } = await card(page);
    if (overflow?.length) overflows.push(...overflow);
    laid.push({ file: file(page), png });
  }

  if (overflows.length > 0)
    throw new Error(
      `og: ${String(overflows.length)} card(s) cannot hold their copy:\n\n` +
        overflows.map((o) => `  · ${describeOverflow(o)}`).join("\n\n") +
        "\n\n  Shorten the copy, or change the size ladder deliberately. Nothing was written.",
    );

  if (check) return laid.map((entry) => entry.file);

  await mkdir(outDir, { recursive: true });
  for (const entry of laid) await writeFile(join(outDir, entry.file), entry.png);
  return laid.map((entry) => entry.file);
}

/** Where a page says its share card is, and the page that says it. */
interface AdvertisedCard {
  page: string;
  url: string;
}

const CARD_META =
  /<meta[^>]+(?:property|name)="(?:og:image|twitter:image)"[^>]+content="([^"]*)"[^>]*>/gi;

function advertisedCards(page: string, html: string): AdvertisedCard[] {
  const seen = new Set<string>();
  const cards: AdvertisedCard[] = [];
  for (const match of html.matchAll(CARD_META)) {
    const url = match[1];
    if (url && !seen.has(url)) {
      seen.add(url);
      cards.push({ page, url });
    }
  }
  return cards;
}

/**
 * The path a card URL points at inside `dist`, or null when the card is not this build's to
 * serve. A `?v=2` or a `#` is addressing, not a file name, so both come off.
 */
function distPathOf(url: string, origin: string): string | null {
  if (url.startsWith("/")) return decodeURIComponent(url.split(/[?#]/)[0] ?? "");
  try {
    const parsed = new URL(url);
    return parsed.origin === origin ? decodeURIComponent(parsed.pathname) : null;
  } catch {
    // Not an address at all. A card URL relative to the page's own folder cannot be resolved
    // without knowing where that page sits, and Open Graph asks for an absolute URL anyway.
    return null;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Every share card a built page advertises is a file that exists.
 *
 * Three repos shipped a page whose `og:image` named a card nothing had ever rendered. All three
 * were `404.html`, all three for the same reason: a card generator walks the page registry, and a
 * not-found shell is not in the registry, so a head built from the same template inherits a card
 * address with no card behind it. Every share of a dead link unfurled broken, in one case in three
 * languages, and **nothing in a browser shows it**. The page looks perfect, and the only reader who
 * finds out is whoever the link was sent to.
 *
 * `bakeHead` cannot catch it: it is handed an `image` and writes it, and a shell carrying the
 * brand card is correct, so it has no way to tell a right image from a wrong one (invariant 12).
 * The build can, because by then the cards are either on disk or they are not. Run it last,
 * after the pages and the cards are written:
 *
 * ```ts
 * await assertOgImages("dist", "https://example.com");
 * ```
 *
 * Cards on another host are somebody else's to serve and are skipped. But a build whose pages all
 * advertise cards and whose origin matches NONE of them has been given the wrong origin, and a
 * check that silently passes is worse than no check, so that is an error too.
 */
export async function assertOgImages(distDir: string, origin: string): Promise<number> {
  const root = siteOrigin(origin);
  const entries = await readdir(distDir, { recursive: true, withFileTypes: true });
  const pages = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath, entry.name));

  const advertised: AdvertisedCard[] = [];
  for (const page of pages) advertised.push(...advertisedCards(page, await readFile(page, "utf8")));

  const mine = advertised
    .map((card) => ({ ...card, file: distPathOf(card.url, root) }))
    .filter((card): card is AdvertisedCard & { file: string } => card.file !== null);

  if (advertised.length > 0 && mine.length === 0)
    throw new Error(
      `og: ${String(advertised.length)} page(s) advertise a share card and none is under ` +
        `${root}, so nothing was checked. Pass the origin this build renders for.`,
    );

  const missing: (AdvertisedCard & { file: string })[] = [];
  for (const card of mine) {
    if (!(await isFile(join(distDir, card.file)))) missing.push(card);
  }

  if (missing.length > 0)
    throw new Error(
      `og: ${String(missing.length)} page(s) advertise a share card that is not in ${distDir}:\n\n` +
        missing.map((card) => `  · ${card.page} → ${card.url}`).join("\n") +
        "\n\n  Either render the card, or leave `image` out of the head for that page.",
    );

  return mine.length;
}
