import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { monorepoWatchFolders, nativeMetroConfig, type ResolutionContext } from "./metro.ts";

// This package's own folder stands in for the app: react and react-native-css are its
// devDependencies, so they resolve from here the way they resolve from an app.
const app = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fromApp = createRequire(join(app, "package.json"));

/**
 * A monorepo root on disk, with the two things a root also holds that Metro must never crawl:
 * other checkouts under `.claude/worktrees`, each with its own node_modules, and a `refs/` folder.
 */
function fakeRepo(workspaces: unknown, folders: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "native-metro-"));
  made.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces }));
  mkdirSync(join(root, "node_modules"));
  for (const folder of [...folders, ".claude/worktrees/x", "refs/heads"]) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, "package.json"), "{}");
  }
  mkdirSync(join(root, ".claude/worktrees/x/node_modules"));
  mkdirSync(join(root, "apps/notes"), { recursive: true }); // a folder with no package.json
  return root;
}
const made: string[] = [];
afterAll(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

const PATTERNS = ["apps/*", "packages/*", "tools/cli", "!packages/legacy"];
const FOLDERS = ["apps/mobile", "apps/web", "packages/shared", "packages/legacy", "tools/cli"];
const repo = fakeRepo(PATTERNS, FOLDERS);

const context: ResolutionContext = {
  resolveRequest: (_context, moduleName) => ({ type: `metro:${moduleName}` }),
};

describe("nativeMetroConfig", () => {
  const config = nativeMetroConfig(
    { projectRoot: app, watchFolders: [app], resolver: { nodeModulesPaths: [] } },
    { monorepoRoot: repo },
  );
  const resolve = (moduleName: string) =>
    config.resolver?.resolveRequest?.(context, moduleName, "ios");

  it("sends react and its entry points to the app's own copy", () => {
    expect(resolve("react")).toEqual({ type: "sourceFile", filePath: fromApp.resolve("react") });
    expect(resolve("react/jsx-runtime")).toEqual({
      type: "sourceFile",
      filePath: fromApp.resolve("react/jsx-runtime"),
    });
  });

  it("leaves packages that only start with the word to Metro", () => {
    for (const name of ["react-native", "react-dom", "react-i18next", "reactive"])
      expect(resolve(name)).toEqual({ type: `metro:${name}` });
  });

  it("maps react-native-css's trap module to its empty override", () => {
    const override = join(dirname(fromApp.resolve("react-native-css/metro")), "override.js");
    expect(resolve("react-native-css-metro-override")).toEqual({
      type: "sourceFile",
      filePath: override,
    });
  });

  it("points Metro at the monorepo without dropping what the config had", () => {
    expect(config.watchFolders).toEqual([
      app,
      ...["node_modules", "apps/mobile", "apps/web", "packages/shared", "tools/cli"].map((each) =>
        join(repo, each),
      ),
    ]);
    expect(config.resolver?.nodeModulesPaths).toEqual([
      join(app, "node_modules"),
      join(repo, "node_modules"),
    ]);
  });

  it("hands what it does not decide to a resolver already on the config", () => {
    const chained = nativeMetroConfig({
      projectRoot: app,
      resolver: { resolveRequest: (_context, moduleName) => ({ type: `own:${moduleName}` }) },
    });
    expect(chained.resolver?.resolveRequest?.(context, "lodash", null)).toEqual({
      type: "own:lodash",
    });
  });

  it("refuses a config with no projectRoot", () => {
    expect(() => nativeMetroConfig({})).toThrow(/getDefaultConfig/);
  });
});

describe("monorepoWatchFolders", () => {
  it("watches node_modules and the workspaces, never the root, other checkouts or refs/", () => {
    const watched = monorepoWatchFolders(repo, join(repo, "apps/mobile"));
    expect(watched).toEqual(
      ["node_modules", "apps/web", "packages/shared", "tools/cli"].map((each) => join(repo, each)),
    );
    expect(watched).not.toContain(repo);
    for (const folder of watched) expect(folder).not.toMatch(/[/\\](\.claude|refs)([/\\]|$)/);
  });

  it("reads the object form of workspaces", () => {
    const root = fakeRepo({ packages: ["apps/*"] }, ["apps/mobile", "apps/web"]);
    expect(monorepoWatchFolders(root, join(root, "apps/mobile"))).toEqual([
      join(root, "node_modules"),
      join(root, "apps/web"),
    ]);
  });

  it("watches only node_modules in a root with no workspaces", () => {
    const root = fakeRepo(undefined, []);
    expect(monorepoWatchFolders(root, join(root, "app"))).toEqual([join(root, "node_modules")]);
  });

  it("refuses ** rather than walk the repository", () => {
    const root = fakeRepo(["packages/**"], []);
    expect(() => monorepoWatchFolders(root, join(root, "app"))).toThrow(/uses \*\*/);
  });
});
