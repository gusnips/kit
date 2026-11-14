import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cssInputs, isBrokenLightningcss } from "./css.ts";

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
