/**
 * The build-time half of a prerendered Vite + React SPA.
 *
 * A Vite SPA ships one `index.html` and draws the rest with JavaScript. Nothing that reads a link
 * for a living runs that bundle, whether it is a search crawler, an LLM or the thing that draws the
 * preview card in a chat app. So the build renders every public route to a real file with a real
 * `<head>` and a real body, and this is the part every app doing that shares.
 *
 * Four repos wrote it independently and each learned something the others had not. What is
 * here is the merge; every non-obvious rule carries the reason it exists.
 *
 * Five things live behind their own subpath, because each drags a dependency this barrel would
 * otherwise force on everyone: the vite config preset at `@gusnips/vite/preset` (the React and
 * Tailwind plugins), `renderTree` at `@gusnips/vite/render`, the theme pre-paint plugin at
 * `@gusnips/vite/theme` (both React itself), the catalog check at `@gusnips/vite/i18n`, and the
 * contrast gate at `@gusnips/vite/contrast` (tailwindcss). The last two run in CI and never in a
 * build. Nothing here imports React, vite or tailwindcss, so a prerender script, an OG generator
 * and a repo that only wants a sitemap all install exactly what they use.
 */
export { resolveKey } from "./catalog.ts";
export {
  llmsTxt,
  mcpDiscoveryJson,
  type LlmsLink,
  type LlmsSection,
  type LlmsTxtOptions,
  type McpDiscoveryAuthentication,
  type McpDiscoveryDocument,
  type McpDiscoveryServer,
  type McpDiscoveryTool,
} from "./discovery.ts";
// `headExtra` takes raw markup, so the moment an adopter builds a tag out of its own copy it
// needs the same escaping every tag this package writes already gets. Exported rather than
// re-invented per app: an adopter's hand-rolled copy is one that can drift from ours, and the
// first one to need it was building a `<link title="…">` out of a translated page title.
export { escapeAttr } from "./escape.ts";
export {
  assertRendered,
  bakeHead,
  EMPTY_ROOT,
  faqJsonLd,
  jsonLd,
  ogLocale,
  type Alternate,
  type FaqEntry,
  type HeadTags,
  type RenderedChecks,
} from "./head.ts";
export {
  assertOgImages,
  loadRenderer,
  loadTemplate,
  writeDist,
  writeOgCards,
  type OgCard,
  type WriteOgCardsOptions,
} from "./node.ts";
export {
  webManifest,
  writeIconSet,
  type ManifestIcon,
  type PackIco,
  type RenderIcon,
  type WebManifestOptions,
  type WriteIconSetOptions,
} from "./icons.ts";
export {
  describeOverflow,
  fitText,
  OG_CANVAS,
  type FitOptions,
  type FitResult,
  type OgOverflow,
} from "./og.ts";
// The locale gate's delivery. Type-only use of vite, so the barrel still imports no peer.
export { prePaintScript, type PrePaintScriptOptions } from "./pre-paint.ts";
// `renderTree` itself is NOT here — it lives at `@gusnips/vite/render`, because it is the one
// thing in this package that loads React. Its consumer is `entry-server.tsx`, a different file
// in a different bundle to the prerender script, and a repo using this only for `sitemapXml`
// and `robotsTxt` should not have to install a renderer. The TYPE is free: it erases.
export type { PageRenderer } from "./render.ts";
export {
  ogImagePath,
  pageFile,
  pageSlug,
  robotsTxt,
  siteOrigin,
  sitemapFor,
  sitemapXml,
  templateOrigin,
  type PublicPage,
  type RobotsOptions,
  type SitemapEntry,
} from "./sitemap.ts";
