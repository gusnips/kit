import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkTokenPairs,
  formatContrastReport,
  loadTokenThemes,
  type ContrastProblem,
  type TokenPairsBundle,
} from "./contrast.ts";

/**
 * `checkTokenPairs` and `loadTokenThemes`, the plain-CSS half of `contrast.ts`. Nothing is
 * compiled, so these read real stylesheets and run in milliseconds, unlike the Tailwind half.
 *
 * Two committed fixtures keep the whole contract (`ok.css`, and `ok-media.css` with both dark
 * blocks wrapped in `@media`) and are the positive controls. Every failing case is one of them
 * with ONE line changed, written to a temp folder: the change sits beside its assertion, and
 * `change` throws when the text it was told to replace is not there, so a fixture edited later
 * cannot turn a test into one that passes for nothing.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures/contrast/tokens");

const bundle: TokenPairsBundle = {
  name: "site",
  css: "tokens.css",
  dark: ':root[data-theme="dark"]',
  system: ":root:not([data-theme])",
  textPairs: [
    ["--ground", "--ink"],
    ["--ground", "--muted"],
    ["--accent", "--accent-ink"],
  ],
  nonTextPairs: [
    ["--ground", "--line"],
    ["--ground", "--accent"],
  ],
};

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtures, name), "utf8");
}

/** Replace text that must be there, every occurrence: the fallback repeats the dark colours. */
function change(css: string, from: string, to: string): string {
  if (!css.includes(from))
    throw new Error(`the fixture no longer contains ${JSON.stringify(from)}`);
  return css.replaceAll(from, to);
}

async function check(css: string, overrides: Partial<TokenPairsBundle> = {}) {
  const root = await mkdtemp(join(tmpdir(), "kit-contrast-tokens-"));
  folders.push(root);
  await writeFile(join(root, "tokens.css"), css);
  return checkTokenPairs([{ ...bundle, ...overrides }], { root });
}

const lineOf = (css: string, text: string): number =>
  css.split("\n").findIndex((line) => line.includes(text)) + 1;

const only = (problems: ContrastProblem[]): ContrastProblem => {
  expect(problems).toHaveLength(1);
  return problems[0]!;
};

describe("checkTokenPairs", () => {
  it("passes a palette whose pairs clear their floors in both themes", async () => {
    const report = await check(await fixture("ok.css"));
    expect(report.problems).toEqual([]);
    expect(formatContrastReport(report)).toBe("✔ contrast: no errors");
  });

  it("reads blocks wrapped in @media, at any depth", async () => {
    const report = await check(await fixture("ok-media.css"));
    expect(report.problems).toEqual([]);
  });

  it("compares the fallback as colours and selectors as selectors, not as text", async () => {
    let css = await fixture("ok.css");
    css = change(css, "    --ink: #f2f2f2;", "    --ink: #F2F2F2;");
    css = change(css, ':root[data-theme="dark"]', ":root[data-theme='dark']");
    expect((await check(css)).problems).toEqual([]);
  });

  it("fails a pair under its floor in the theme where it fails, and points at the line", async () => {
    const css = change(await fixture("ok.css"), "--muted: #b3b3b3", "--muted: #3a3a3a");
    const report = await check(css);
    const found = only(report.problems);
    expect(found).toMatchObject({ rule: "floor", level: "error", bundle: "site" });
    expect(found.message).toBe(
      "dark: --muted (#3a3a3a) on --ground (#121212) is 1.65:1, under the 4.5:1 floor for text (WCAG 1.4.3)",
    );
    expect(found.at).toBe(`tokens.css:${String(lineOf(css, "--muted: #3a3a3a"))}`);
    // The formatter is checkContrast's own, so a repo prints and exits the same way for both.
    expect(formatContrastReport(report)).toContain("✖ contrast: 1 error(s)");
  });

  it("holds a pair that is not text to the lower floor", async () => {
    const css = change(await fixture("ok.css"), "--line: #767676", "--line: #cccccc");
    expect(only((await check(css)).problems).message).toBe(
      "light: --line (#cccccc) on --ground (#ffffff) is 1.61:1, under the 3:1 floor for a control or icon (WCAG 1.4.11)",
    );
  });

  it("takes the floors from the bundle", async () => {
    const css = change(await fixture("ok.css"), "--muted: #555555", "--muted: #999999");
    expect(only((await check(css)).problems).message).toContain("2.85:1, under the 4.5:1 floor");
    expect((await check(css, { textFloor: 2.5 })).problems).toEqual([]);
    // Raising the non-text floor fails the untouched palette: --line is 4.54:1 in the light theme.
    const strict = await check(await fixture("ok.css"), { nonTextFloor: 5 });
    expect(only(strict.problems).message).toContain(
      "light: --line (#767676) on --ground (#ffffff) is 4.54:1",
    );
  });

  it("reports a colour one theme declares and the other does not, once", async () => {
    // The dark block loses --line (and the fallback with it, so only one rule fires).
    const noDark = change(await fixture("ok.css"), "  --line: #8a8a8a;\n", "");
    const dropped = only((await check(noDark)).problems);
    expect(dropped.rule).toBe("missing");
    expect(dropped.message).toContain("`--line` is in the light block but not in the dark block");
    expect(dropped.at).toBe(`tokens.css:${String(lineOf(noDark, "--line: #767676"))}`);

    const noLight = change(await fixture("ok.css"), "  --accent-ink: #fff;\n", "");
    const unbound = only((await check(noLight)).problems);
    expect(unbound.rule).toBe("missing");
    expect(unbound.message).toContain("`--accent-ink` is in the dark block but not in the light");
  });

  it("reports a pair that names a token no block declares, once however many pairs use it", async () => {
    const report = await check(await fixture("ok.css"), {
      textPairs: [
        ["--ground", "--inkk"],
        ["--inkk", "--muted"],
        ["ground", "--ink"],
      ],
    });
    expect(report.problems.map((p) => p.rule)).toEqual(["missing", "missing"]);
    expect(report.problems[0]?.message).toContain("`--inkk`, which neither the light nor");
    expect(report.problems[1]?.message).toContain("`ground`");
    expect(report.problems[1]?.message).toContain("start with --");
  });

  it("fails a fallback that holds a different colour, naming both", async () => {
    const css = change(await fixture("ok.css"), "    --ink: #f2f2f2;", "    --ink: #eeeeee;");
    const found = only((await check(css)).problems);
    expect(found.rule).toBe("mirror");
    expect(found.message).toBe(
      "`--ink` is #f2f2f2 in the dark block but #eeeeee in the system block",
    );
    expect(found.at).toBe(`tokens.css:${String(lineOf(css, "--ink: #eeeeee"))}`);
  });

  it("fails a fallback that lacks a token, or holds one the dark block lacks", async () => {
    const lacks = change(await fixture("ok.css"), "    --line: #8a8a8a;\n", "");
    expect(only((await check(lacks)).problems).message).toBe(
      "`--line` is in the dark block but not in the system block",
    );
    const extra = change(
      await fixture("ok.css"),
      "    --accent: #7ab7ff;",
      "    --accent: #7ab7ff;\n    --extra: #000000;",
    );
    expect(only((await check(extra)).problems).message).toBe(
      "`--extra` is in the system block but not in the dark block",
    );
  });

  it("fails a fallback written outside @media (prefers-color-scheme: dark)", async () => {
    const css = change(
      await fixture("ok.css"),
      "@media (prefers-color-scheme: dark)",
      "@media print",
    );
    const found = only((await check(css)).problems);
    expect(found.rule).toBe("mirror");
    expect(found.message).toContain("is not inside @media (prefers-color-scheme: dark)");
  });

  it("fails a fallback that is not there, and reads none when the bundle names none", async () => {
    const css = await fixture("ok.css");
    const absent = only((await check(css, { system: ":root:not([data-mode])" })).problems);
    expect(absent.rule).toBe("mirror");
    expect(absent.message).toContain("no `:root:not([data-mode])` block");

    const differs = change(css, "    --ink: #f2f2f2;", "    --ink: #eeeeee;");
    expect((await check(differs, { system: undefined })).problems).toEqual([]);
  });

  it("fails a pair it cannot measure, and leaves tokens no pair uses alone", async () => {
    // ok.css already carries `--radius: 8px` in the light block and passes: geometry is skipped.
    const css = change(await fixture("ok.css"), "--muted: #555555", "--muted: rgb(85 85 85)");
    const found = only((await check(css)).problems);
    expect(found.rule).toBe("floor");
    expect(found.message).toContain("cannot measure --muted (rgb(85 85 85))");
  });

  it("a stylesheet or block that is not there fails the gate instead of passing it", async () => {
    const css = await fixture("ok.css");
    const noFile = await checkTokenPairs([bundle], { root: fixtures });
    expect(only(noFile.problems)).toMatchObject({
      rule: "load",
      message: "tokens.css could not be read",
    });

    const noDark = only((await check(css, { dark: '[data-theme="night"]' })).problems);
    expect(noDark.rule).toBe("load");
    expect(noDark.message).toContain('no `[data-theme="night"]` block for the dark colours');

    const same = only((await check(css, { light: bundle.dark })).problems);
    expect(same.rule).toBe("load");
    expect(same.message).toContain("must differ");
  });

  it("does not read a block that holds another block", async () => {
    const css = change(
      await fixture("ok.css"),
      "  --accent-ink: #0a1a2b;\n}\n\n@media",
      "  --accent-ink: #0a1a2b;\n  & a {\n    color: red;\n  }\n}\n\n@media",
    );
    expect(only((await check(css)).problems).rule).toBe("load");
  });
});

describe("loadTokenThemes", () => {
  it("hands back both palettes as hex, so an adopter can add a check of its own", async () => {
    const { light, dark } = await loadTokenThemes(
      { css: "ok.css", dark: bundle.dark },
      { root: fixtures },
    );
    expect(light.get("--ground")).toBe("#ffffff");
    expect(dark.get("--ground")).toBe("#121212");
    // `#fff` comes back as `#ffffff`, and `--radius: 8px` is geometry, not a colour.
    expect(light.get("--accent-ink")).toBe("#ffffff");
    expect(light.has("--radius")).toBe(false);
  });

  it("throws, saying what is missing, rather than returning two empty palettes", async () => {
    await expect(
      loadTokenThemes({ css: "ok.css", dark: '[data-theme="night"]' }, { root: fixtures }),
    ).rejects.toThrow('no `[data-theme="night"]` block');
    await expect(
      loadTokenThemes({ css: "nope.css", dark: bundle.dark }, { root: fixtures }),
    ).rejects.toThrow("nope.css could not be read");
  });
});
