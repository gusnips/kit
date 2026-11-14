#!/usr/bin/env bun
/**
 * Platform-purity check.
 *
 * Lifted from a donor's `packages/shared/scripts/check-purity.ts`, which already had the
 * shape and the reason: **tsc cannot promise this.** A root-level `@types/node` is visible
 * to every workspace, so a stray `import { readFile } from "node:fs"` inside `react/`
 * typechecks fine and then blows up in a browser bundle. Only reading the source catches it.
 *
 * The rule per package IS the package split, restated as a test:
 *
 *   http/    no Node, no browser globals. The API server, the browser and the SDK all
 *            compile it unchanged; anything platform-shaped breaks one of the three.
 *   react/   no Node. Browser globals are the point — but see the SSR note below.
 *   vite/    unrestricted. It is the only package allowed `node:fs`, and having somewhere
 *            for that to live is the reason the other three can be strict.
 *
 * What this does NOT catch, and no grep can: a browser global read at MODULE SCOPE inside
 * `react/`, which crashes a prerender rather than a bundle. One donor's `themeStore.ts` was the
 * live example — `localStorage` inside `create()`, evaluated at import, so blocked site data
 * threw before React mounted and no ErrorBoundary could catch it. Module-scope browser access
 * is a review rule, checked by eye at every extraction.
 *
 * Run: bun run scripts/check-purity.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

interface Rule {
  pattern: RegExp;
  category: "node" | "browser";
  description: string;
}

const NODE_RULE: Rule = {
  pattern:
    /(?:from\s+['"]|import\s*\(\s*['"]|import\s+['"]|require\s*\(\s*['"])(?:node:)?(?:fs|path|os|child_process|crypto|net|http|https|stream|buffer|worker_threads|cluster|dns|tls|dgram|readline|vm|zlib|util|url|querystring|assert|events|process)(?:\/[^'"]*)?['"]|(?:^|[^.\w$])(?:process\.env|Buffer)\b/,
  category: "node",
  description: "Node.js built-in or global",
};

const BROWSER_RULE: Rule = {
  pattern:
    /(?:^|[^./'"\w$])(?:window|document|navigator|localStorage|sessionStorage|XMLHttpRequest)\s*[.,[;)}\n]/,
  category: "browser",
  description: "Browser-only global",
};

/** Which rules apply where. A package missing from this map is not checked. */
const PACKAGES: Record<string, Rule[]> = {
  http: [NODE_RULE, BROWSER_RULE],
  locale: [NODE_RULE, BROWSER_RULE],
  br: [NODE_RULE, BROWSER_RULE],
  cnpj: [NODE_RULE, BROWSER_RULE],
  react: [NODE_RULE],
  // vite/ is deliberately absent — it is the package that gets to touch the filesystem.
  // tokens/ too, and for a different reason worth saying rather than leaving as a gap in a map:
  // it ships no JavaScript at all, so its only `.ts` is the build-time Tailwind compile check,
  // which is a script and reads files by design.
  // oxlint/ ships two JSON files, and its only `.ts` is the check that runs oxlint over a fixture.
};

const TEST_FILE = /(?:^|\/)(?:__tests__\/|[^/]+\.test\.tsx?$)/;

async function collectTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTsFiles(full)));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

interface Violation {
  file: string;
  line: number;
  content: string;
  rule: Rule;
}

function scan(file: string, content: string, root: string, rules: Rule[]): Violation[] {
  const found: Violation[] = [];
  const lines = stripComments(content).split("\n");
  for (const [i, line] of lines.entries()) {
    for (const rule of rules) {
      if (rule.pattern.test(line))
        found.push({ file: relative(root, file), line: i + 1, content: line.trim(), rule });
    }
  }
  return found;
}

async function main(): Promise<void> {
  const root = join(import.meta.dirname, "..");
  const violations: Violation[] = [];
  let checked = 0;

  for (const [pkg, rules] of Object.entries(PACKAGES)) {
    const src = join(root, pkg, "src");
    const files = (await collectTsFiles(src).catch(() => [])).filter(
      (f) => !TEST_FILE.test(relative(root, f)),
    );
    checked += files.length;
    for (const file of files) {
      violations.push(...scan(file, await readFile(file, "utf-8"), root, rules));
    }
  }

  if (violations.length === 0) {
    console.log(`✓ purity: ${checked} files, no platform leaks.`);
    return;
  }

  console.error("✗ purity check FAILED — a package reached for a platform it does not have.\n");
  for (const category of ["node", "browser"] as const) {
    const hits = violations.filter((v) => v.rule.category === category);
    if (hits.length === 0) continue;
    console.error(`  [${category}] ${hits.length} violation(s):`);
    for (const v of hits) {
      console.error(`    ${v.file}:${v.line} — ${v.rule.description}`);
      console.error(`      ${v.content}`);
    }
    console.error("");
  }
  process.exit(1);
}

await main();
