#!/usr/bin/env bun
/**
 * Entry-point weight check — invariant 15, stated as something a machine can fail.
 *
 * **The rule: a peer marked `optional` must not be reachable from the package's main entry.**
 *
 * An optional peer the barrel imports anyway is not optional. It is a required peer whose error
 * moved from install time (where a package manager explains it) to the adopter's first build
 * (where a bundler says "failed to resolve import" and names our file, not their missing
 * install). That is strictly the worse of the two places to find out.
 *
 * This has now happened four times, twice in our own code. Each earlier one was found by hand:
 * `hydrate.ts` sat in `react/`'s barrel beside two string constants, so a build script reading
 * `PRERENDERED_ROUTE_ATTR` loaded `react-dom/client`; `renderTree` sat in `vite/`'s, so a script
 * that only wanted `sitemapXml` loaded `react-dom/static.browser`. The fourth was `zustand` and
 * `react-router-dom` in `@gusnips/react`, both declared optional and both imported unconditionally
 * by the one entry point everybody uses.
 *
 * Why this reads `dist/` and not `src/`: a type-only re-export looks identical in source and
 * disappears at runtime. `export type { PageRenderer } from "./render.ts"` costs nothing;
 * `export { renderTree } from "./render.ts"` loads React. Reading the source answers a different
 * question than the one that matters, so this walks the BUILT graph. It follows relative imports
 * only — a bare specifier is where the walk stops and the finding starts.
 *
 * Also checks that every path in every `exports` map points at a file that exists, because a
 * typo there is invisible until someone installs the package and cannot import it.
 *
 * Run: bun run scripts/check-exports.ts   (after a build — the gate does that first)
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PACKAGES = [
  "tokens",
  "http",
  "locale",
  "br",
  "cnpj",
  "react",
  "vite",
  "migrate",
  "sdkgen",
  "server",
];

interface PackageJson {
  name: string;
  exports?: Record<string, string | Record<string, string>>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/** `@base-ui/react/menu` → `@base-ui/react`; `react-dom/client` → `react-dom`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Every file path an `exports` entry can point at, whatever conditions it is wrapped in. */
function targetsOf(entry: string | Record<string, string>): string[] {
  return typeof entry === "string" ? [entry] : Object.values(entry);
}

/**
 * Every bare specifier reachable from `entry` by following relative imports.
 *
 * Resolution is deliberately dumb: emitted ESM from `tsc` with
 * `rewriteRelativeImportExtensions` always writes a real `./x.js`, so there is no extension
 * guessing to do and nothing to get subtly wrong.
 */
async function bareImports(
  entry: string,
  seen = new Set<string>(),
  found = new Set<string>(),
): Promise<Set<string>> {
  const abs = resolve(entry);
  if (seen.has(abs)) return found;
  seen.add(abs);

  const source = await readFile(abs, "utf-8").catch(() => null);
  if (source === null) return found;

  for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    // The pattern's one group always captures; this only tells the compiler so.
    if (specifier === undefined) continue;
    if (specifier.startsWith(".")) await bareImports(resolve(dirname(abs), specifier), seen, found);
    else found.add(specifier);
  }
  return found;
}

async function main(): Promise<void> {
  const problems: string[] = [];
  let entries = 0;

  for (const pkg of PACKAGES) {
    const dir = join(ROOT, pkg);
    const manifest: PackageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    const exportsMap = manifest.exports ?? {};

    // A missing `dist/` means "not built yet", not "your exports map is wrong". Left to the
    // check below it reports the second — one line per entry point, each sending somebody to
    // hunt a typo in a path that is correct. Say the real cause once instead, and name the fix.
    const built = Object.values(exportsMap).some((entry) =>
      targetsOf(entry).some((target) => target.startsWith("./dist/")),
    );
    if (built && !(await stat(join(dir, "dist")).catch(() => null))) {
      problems.push(`${manifest.name}: nothing built yet — run \`bun run build\` first`);
      continue;
    }

    // Every declared export must exist. A typo here surfaces only on someone else's install.
    for (const [subpath, entry] of Object.entries(exportsMap)) {
      for (const target of targetsOf(entry)) {
        entries++;
        const file = join(dir, target);
        if (!(await stat(file).catch(() => null)))
          problems.push(`${manifest.name}: "${subpath}" points at ${target}, which does not exist`);
      }
    }

    const optional = Object.entries(manifest.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional)
      .map(([name]) => name);
    if (optional.length === 0) continue;

    const main = exportsMap["."];
    if (!main) continue;
    const js = targetsOf(main).find((t) => t.endsWith(".js"));
    if (!js) continue;

    const reachable = await bareImports(join(dir, js));
    for (const specifier of reachable) {
      const owner = packageOf(specifier);
      if (optional.includes(owner))
        problems.push(
          `${manifest.name}: "." reaches optional peer "${owner}" (as "${specifier}") — ` +
            `move that export behind a subpath, or drop the peer's optional flag`,
        );
    }
  }

  if (problems.length === 0) {
    console.log(`✓ exports: ${entries} entry points resolve, no optional peer in a main barrel.`);
    return;
  }

  console.error("✗ exports check FAILED\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("");
  process.exit(1);
}

await main();
