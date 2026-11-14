/**
 * The Metro config a bare React Native app needs inside a bun monorepo.
 *
 * Three things, each learned by a crash:
 *
 * - **Metro does not find workspaces on its own.** `watchFolders` and `nodeModulesPaths` point it at
 *   the monorepo, so a workspace package that ships TypeScript source resolves like any other.
 *   (Symlinks and package `exports` are on by default since Metro 0.79 and 0.82.) It watches the
 *   root's `node_modules` and each workspace folder, NEVER the root itself: see
 *   {@link monorepoWatchFolders}.
 * - **One React, the app's.** bun's isolated store keeps a spare `react` at its root, and a package
 *   that forgets to declare react as a peer resolves `react` by walking up to THAT copy. Two Reacts
 *   in one bundle: the app's own screens render, and that package's hooks crash with "Cannot read
 *   property 'useMemo' of null". So every `react` and `react/*` import goes to the copy the app
 *   itself resolves.
 * - **react-native-css's override module.** `react-native-css/native` re-exports a module named
 *   `react-native-css-metro-override` that throws on import unless Metro maps it to the package's
 *   own empty `override.js`. Without the mapping every styled component dies at launch with "Cannot
 *   read property 'useCssElement' of undefined". `withReactNativeCSS` does map it, and also swaps
 *   Metro's transformer for one that requires `@expo/metro-config`, which a bare app does not have.
 *   Only the mapping is taken here; the CSS itself is built ahead of time by `gusnips-native-css`.
 *   Skipped when the app does not use react-native-css.
 *
 * Metro's own types are not imported: this package does not depend on metro, and the few fields read
 * here are stated below.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/** What a resolver hands back to Metro. Only the `sourceFile` form is built here. */
export type Resolution = { type: "sourceFile"; filePath: string } | { type: string };

/** Metro's `CustomResolver`, narrowed to the part this file reads. */
export type ResolveRequest = (
  context: ResolutionContext,
  moduleName: string,
  platform: string | null,
) => Resolution;

export interface ResolutionContext {
  /** Metro's default resolver, for everything this one does not decide. */
  readonly resolveRequest: ResolveRequest;
}

export interface MetroConfigInput {
  readonly projectRoot?: string;
  readonly watchFolders?: readonly string[];
  readonly resolver?: {
    readonly nodeModulesPaths?: readonly string[];
    readonly resolveRequest?: ResolveRequest | null;
  };
}

export interface NativeMetroOptions {
  /**
   * The monorepo's root folder, where the root `package.json` and `node_modules` are. Leave it out
   * for an app that is not in a monorepo.
   */
  monorepoRoot?: string;
}

/**
 * Wrap the config `@react-native/metro-config` gives you.
 *
 * ```js
 * // metro.config.js
 * const { getDefaultConfig } = require("@react-native/metro-config");
 * const { nativeMetroConfig } = require("@gusnips/native/metro");
 *
 * module.exports = nativeMetroConfig(getDefaultConfig(__dirname), {
 *   monorepoRoot: require("node:path").resolve(__dirname, "../.."),
 * });
 * ```
 *
 * A resolver already on the config still runs for everything this one does not decide.
 */
export function nativeMetroConfig<C extends MetroConfigInput>(
  config: C,
  { monorepoRoot }: NativeMetroOptions = {},
) {
  const { projectRoot } = config;
  if (!projectRoot)
    throw new Error(
      "nativeMetroConfig: the config has no projectRoot. Pass it the config " +
        "getDefaultConfig(__dirname) returns, which always sets one.",
    );

  const fromApp = createRequire(join(projectRoot, "package.json"));
  const cssOverride = reactNativeCssOverride(fromApp);
  const next = config.resolver?.resolveRequest ?? null;

  const resolveRequest: ResolveRequest = (context, moduleName, platform) => {
    if (cssOverride && moduleName.includes("react-native-css-metro-override"))
      return { type: "sourceFile", filePath: cssOverride };
    if (isReact(moduleName)) return { type: "sourceFile", filePath: fromApp.resolve(moduleName) };
    return (next ?? context.resolveRequest)(context, moduleName, platform);
  };

  const extraRoots = monorepoRoot ? [monorepoRoot] : [];
  return {
    ...config,
    watchFolders: unique([
      ...(config.watchFolders ?? []),
      ...(monorepoRoot ? monorepoWatchFolders(monorepoRoot, projectRoot) : []),
    ]),
    resolver: {
      ...config.resolver,
      nodeModulesPaths: unique([
        ...[projectRoot, ...extraRoots].map((root) => join(root, "node_modules")),
        ...(config.resolver?.nodeModulesPaths ?? []),
      ]),
      resolveRequest,
    },
  };
}

/**
 * What Metro watches in a monorepo: the root's `node_modules` (bun's store is under it, and every
 * package the app resolves lives there) and each workspace folder named by the root
 * `package.json`'s `workspaces`, minus the app's own folder, which Metro watches already.
 *
 * Never the root. Without watchman, Metro's file map crawls each watched folder with `find` and
 * keeps all of its output in one string, and a root holds everything else too: one adopter's had
 * 55 checkouts under `.claude/worktrees`, each with its own `node_modules`. On Node 24.21 the
 * crawl died after about four minutes with "RangeError: Invalid string length"
 * (metro-file-map 0.84.4); on Node 26.0 it sat at 1% CPU for fifteen. A `resolver.blockList` does
 * not help, because `find` still walks what the list hides. Watching only these folders, the same
 * app's release bundle finished.
 *
 * `workspaces` may be a list or `{ packages: [...] }`. A pattern is a literal path or uses `*` for
 * one folder name, which skips dot folders the way the package managers do, and `!` excludes. A
 * folder counts only when it holds a `package.json`.
 *
 * ponytail: `**` is refused rather than expanded. No workspace list on this stack uses it, and a
 * recursive walk from the root is the crawl this function exists to avoid.
 */
export function monorepoWatchFolders(monorepoRoot: string, projectRoot: string): string[] {
  const root = resolve(monorepoRoot);
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath))
    throw new Error(`nativeMetroConfig: no package.json at monorepoRoot (${root}).`);
  const manifest: { workspaces?: unknown } = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const app = resolve(projectRoot);
  const patterns = workspacePatterns(manifest.workspaces);
  const excluded = new Set(
    patterns.filter((each) => each.startsWith("!")).flatMap((each) => expand(root, each.slice(1))),
  );
  const workspaces = patterns
    .filter((each) => !each.startsWith("!"))
    .flatMap((each) => expand(root, each))
    .filter((folder) => !excluded.has(folder) && folder !== app);
  return unique([join(root, "node_modules"), ...workspaces]);
}

function workspacePatterns(workspaces: unknown): string[] {
  const list =
    typeof workspaces === "object" && workspaces !== null && "packages" in workspaces
      ? workspaces.packages
      : workspaces;
  return Array.isArray(list) ? list.filter((each) => typeof each === "string") : [];
}

/** The folders a pattern names, each holding a package.json. */
function expand(root: string, pattern: string): string[] {
  const segments = pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  if (segments.includes("**"))
    throw new Error(
      `nativeMetroConfig: the workspace pattern "${pattern}" uses **. Name each level with * ` +
        "instead, so Metro is not sent to walk the repository.",
    );
  let folders = [root];
  for (const segment of segments) {
    folders = folders.flatMap((folder) => {
      if (!segment.includes("*")) return [join(folder, segment)];
      if (!existsSync(folder)) return [];
      const matches = new RegExp(`^${segment.split("*").map(escapeRegExp).join("[^/]*")}$`);
      return readdirSync(folder, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && !entry.name.startsWith(".") && matches.test(entry.name),
        )
        .map((entry) => join(folder, entry.name));
    });
  }
  return folders.filter((folder) => existsSync(join(folder, "package.json")));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `react` and its own entry points, and nothing that merely starts with the word: `react-native`,
 * `react-dom` and `react-i18next` are packages of their own and resolve the normal way.
 *
 * ponytail: only react is forced to one copy, because only react has been seen twice. If another
 * package turns up twice in a bundle (react-native itself is the likely next), add it here.
 */
function isReact(moduleName: string): boolean {
  return moduleName === "react" || moduleName.startsWith("react/");
}

/** The app's react-native-css `override.js`, or null when the app has no react-native-css. */
function reactNativeCssOverride(fromApp: NodeRequire): string | null {
  let metroEntry: string;
  try {
    metroEntry = fromApp.resolve("react-native-css/metro");
  } catch {
    return null;
  }
  const override = join(dirname(metroEntry), "override.js");
  if (!existsSync(override))
    throw new Error(
      `nativeMetroConfig: react-native-css is installed, but ${override} is not there. This ` +
        "version keeps its override module somewhere else; @gusnips/native needs updating for it.",
    );
  return override;
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
