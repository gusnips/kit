import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nativeMetroConfig, type ResolutionContext } from "./metro.ts";

// This package's own folder stands in for the app: react and react-native-css are its
// devDependencies, so they resolve from here the way they resolve from an app.
const app = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fromApp = createRequire(join(app, "package.json"));

const context: ResolutionContext = {
  resolveRequest: (_context, moduleName) => ({ type: `metro:${moduleName}` }),
};

describe("nativeMetroConfig", () => {
  const config = nativeMetroConfig(
    { projectRoot: app, watchFolders: [app], resolver: { nodeModulesPaths: [] } },
    { monorepoRoot: "/repo" },
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
    expect(config.watchFolders).toEqual([app, "/repo"]);
    expect(config.resolver?.nodeModulesPaths).toEqual([
      join(app, "node_modules"),
      "/repo/node_modules",
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
