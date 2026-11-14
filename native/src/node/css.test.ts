import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cssInputs, isBrokenLightningcss, paletteColors } from "./css.ts";
import type { ReactNativeCssStyleSheet } from "react-native-css/compiler";

describe("isBrokenLightningcss", () => {
  it("lets 1.30.1 and earlier through", () => {
    for (const version of ["1.30.1", "1.30.0", "1.29.3", "1.0.0", "0.9.9"])
      expect(isBrokenLightningcss(version), version).toBe(false);
  });

  it("refuses every release after 1.30.1, the measured ones included", () => {
    for (const version of ["1.30.2", "1.30.10", "1.31.0", "1.32.0", "1.33.0", "2.0.0"])
      expect(isBrokenLightningcss(version), version).toBe(true);
  });

  it("reads a prerelease or build suffix by its numbers", () => {
    expect(isBrokenLightningcss("1.30.1-beta.2")).toBe(false);
    expect(isBrokenLightningcss("1.30.2+build.7")).toBe(true);
  });
});

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("cssInputs: what makes --watch build again", () => {
  it("is the entry and every local file it imports, followed through their own imports", async () => {
    const app = await mkdtemp(join(tmpdir(), "native-css-inputs-"));
    made.push(app);
    const shared = join(app, "packages", "shared");
    await mkdir(shared, { recursive: true });
    await mkdir(join(app, "mobile"), { recursive: true });
    await writeFile(
      join(app, "mobile", "global.css"),
      [
        '@import "tailwindcss/theme.css" layer(theme);', // a package: changes only on install
        '@import "nativewind/theme";',
        '@import "../packages/shared/tokens.css";',
        '/* @import "./commented-out.css"; */',
        '@import url("./fonts.css");',
        '@import "./missing.css";', // a typo is Tailwind's error to report, not a file to watch
      ].join("\n"),
    );
    await writeFile(join(app, "mobile", "fonts.css"), ":root { --font-sans: Inter; }");
    await writeFile(join(app, "mobile", "commented-out.css"), "");
    await writeFile(join(shared, "tokens.css"), '@import "./colors.css";\n@theme {}');
    await writeFile(join(shared, "colors.css"), '@import "./tokens.css";'); // a cycle ends

    expect((await cssInputs(join(app, "mobile", "global.css"))).sort()).toEqual(
      [
        join(app, "mobile", "fonts.css"),
        join(app, "mobile", "global.css"),
        join(shared, "colors.css"),
        join(shared, "tokens.css"),
      ].sort(),
    );
  });
});

// What react-native-css 3.0.7 wrote for this CSS, built with gusnips-native-css:
//   :root { --surface: #fcfcfd; --ink: oklch(0.2 0.01 260) }
//   @media (prefers-color-scheme: dark) { :root { --surface: #131416; --ink: #f1f2f3 } }
//   @theme { --color-surface: var(--surface) }   and a class using it, bg-surface
// plus a variable pointing at another one, and a font family that changes by platform.
const SHEET: ReactNativeCssStyleSheet = {
  s: [
    ["bg-surface", [{ s: [2, 1], d: [{ backgroundColor: "#fcfcfd" }] }]],
    ["text-ink", [{ s: [4, 1], d: [{ color: [{}, "var", ["ink"], 1] }] }]],
  ],
  vr: [
    ["surface", [["#131416", [["=", "prefers-color-scheme", "dark"]]], ["#fcfcfd"]]],
    ["ink", [["#f1f2f3", [["=", "prefers-color-scheme", "dark"]]], ["#13161b"]]],
    ["brand", [[[{}, "var", ["ink"], 1]]]],
    ["font-sans", [["Inter-Regular", [["=", "platform", "ios"]]], ["System"]]],
  ],
};

describe("paletteColors", () => {
  it("reads a variable's light and dark values, following one that points at another", () => {
    expect(paletteColors(SHEET, { canvas: "--surface", text: "--ink", brand: "--brand" })).toEqual({
      light: { canvas: "#fcfcfd", text: "#13161b", brand: "#13161b" },
      dark: { canvas: "#131416", text: "#f1f2f3", brand: "#f1f2f3" },
    });
  });

  it("still reads a class per scheme beside a variable", () => {
    expect(
      paletteColors(SHEET, { canvas: { light: "bg-surface", dark: "bg-surface" }, text: "--ink" }),
    ).toEqual({
      light: { canvas: "#fcfcfd", text: "#13161b" },
      dark: { canvas: "#fcfcfd", text: "#f1f2f3" },
    });
  });

  it("names the variable to use when a class paints one", () => {
    expect(() => paletteColors(SHEET, { text: { light: "text-ink", dark: "text-ink" } })).toThrow(
      /Name the variable instead: "--ink"/,
    );
  });

  it("refuses a variable that is not there, or is not a colour", () => {
    expect(() => paletteColors(SHEET, { accent: "--accent" })).toThrow(/No variable --accent/);
    expect(() => paletteColors(SHEET, { font: "--font-sans" })).toThrow(/not a hex colour/);
  });
});
