/**
 * The Metro config a bare React Native app needs inside a bun monorepo.
 *
 * Three things, each learned by a crash:
 *
 * - **Metro does not find workspaces on its own.** `watchFolders` and `nodeModulesPaths` point it at
 *   the monorepo, so a workspace package that ships TypeScript source resolves like any other.
 *   (Symlinks and package `exports` are on by default since Metro 0.79 and 0.82.)
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
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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
    watchFolders: unique([...(config.watchFolders ?? []), ...extraRoots]),
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
