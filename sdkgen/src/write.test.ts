import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { writeGenerated } from "./write.ts";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "sdkgen-write-"));
  // The repo's own style, which the output must follow rather than prettier's defaults.
  writeFileSync(join(root, ".prettierrc"), JSON.stringify({ tabWidth: 4 }));
  return root;
}

const UGLY = "export interface A {\na: string\n}\n";
const PRETTY = "export interface A {\n    a: string;\n}\n";

describe("writeGenerated", () => {
  it("writes each file through the repo's prettier config, creating its folder", async () => {
    const root = repo();
    const path = join(root, "src/generated/a.ts");
    expect(await writeGenerated({ [path]: UGLY })).toEqual({ written: [path], stale: [] });
    expect(readFileSync(path, "utf8")).toBe(PRETTY);
  });

  it("reads a relative path from root, and reports it as given", async () => {
    const root = repo();
    const name = "src/generated/a.ts";
    expect(await writeGenerated({ [name]: UGLY }, { root, check: true })).toEqual({
      written: [],
      stale: [name],
    });
    expect(await writeGenerated({ [name]: UGLY }, { root })).toEqual({
      written: [name],
      stale: [],
    });
    expect(readFileSync(join(root, name), "utf8")).toBe(PRETTY);
  });

  it("leaves a current file alone", async () => {
    const root = repo();
    const path = join(root, "a.ts");
    writeFileSync(path, PRETTY);
    expect(await writeGenerated({ [path]: UGLY })).toEqual({ written: [], stale: [] });
    expect(await writeGenerated({ [path]: UGLY }, { check: true })).toEqual({
      written: [],
      stale: [],
    });
  });

  it("when checking, lists a missing or different file and writes nothing", async () => {
    const root = repo();
    const changed = join(root, "a.ts");
    const missing = join(root, "b.ts");
    writeFileSync(changed, "export {};\n");
    expect(await writeGenerated({ [changed]: UGLY, [missing]: UGLY }, { check: true })).toEqual({
      written: [],
      stale: [changed, missing],
    });
    expect(readFileSync(changed, "utf8")).toBe("export {};\n");
  });

  it("fails on a file it cannot read, rather than calling it stale", async () => {
    const folder = join(repo(), "a.ts");
    mkdirSync(folder);
    await expect(writeGenerated({ [folder]: UGLY }, { check: true })).rejects.toThrow(/EISDIR/);
  });
});

describe("writeGenerated in a repo that formats with oxfmt", () => {
  // The oxfmt this package is tested against, which a repo would have in its own node_modules.
  const OXFMT = fileURLToPath(new URL("../node_modules/.bin/oxfmt", import.meta.url));
  // Three spaces: prettier's config below says four and oxfmt's default is two, so only an oxfmt
  // that read its own config can write this.
  const OXFMT_PRETTY = "export interface A {\n   a: string;\n}\n";

  function oxfmtRepo(config = ".oxfmtrc.json", { installed = true } = {}): string {
    const root = repo();
    writeFileSync(
      join(root, config),
      config.endsWith("c") ? '// 3\n{ "tabWidth": 3 }' : '{ "tabWidth": 3 }',
    );
    if (installed) {
      mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
      symlinkSync(OXFMT, join(root, "node_modules/.bin/oxfmt"));
    }
    return root;
  }

  it.each([".oxfmtrc.json", ".oxfmtrc.jsonc"])(
    "formats with oxfmt where %s is above the file, even beside a prettier config",
    async (config) => {
      const root = oxfmtRepo(config);
      const name = "src/generated/a.ts";
      // The positive control: stale before, written, then current. A check that cannot go from
      // stale to current would pass for the wrong formatter too.
      expect(await writeGenerated({ [name]: UGLY }, { root, check: true })).toEqual({
        written: [],
        stale: [name],
      });
      expect(await writeGenerated({ [name]: UGLY }, { root })).toEqual({
        written: [name],
        stale: [],
      });
      expect(readFileSync(join(root, name), "utf8")).toBe(OXFMT_PRETTY);
      expect(await writeGenerated({ [name]: UGLY }, { root, check: true })).toEqual({
        written: [],
        stale: [],
      });
    },
    // Each call starts an oxfmt process, and on a busy machine that takes seconds. vitest's 5 s
    // default failed these twice in three runs at a load average near 300.
    60_000,
  );

  it("says to install oxfmt when the repo has the config and not the binary", async () => {
    const root = oxfmtRepo(".oxfmtrc.json", { installed: false });
    await expect(writeGenerated({ "a.ts": UGLY }, { root })).rejects.toThrow(/bun add -d oxfmt/);
  });

  it("names the file oxfmt could not format", async () => {
    const root = oxfmtRepo();
    await expect(writeGenerated({ "a.ts": "export const = ;" }, { root })).rejects.toThrow(
      /oxfmt could not format .*a\.ts/,
    );
  }, 60_000);
});
