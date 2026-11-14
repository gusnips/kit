/**
 * Writing generated files, or proving the ones on disk are current.
 *
 * Every file goes through the repo's own formatter first. The output is checked in and read by
 * whoever opens the SDK, and formatting it here is also what keeps `format:check` and the
 * generator's own check from ever disagreeing about one file.
 *
 * The formatter is the one the repo uses. A file with an `.oxfmtrc.json` or `.oxfmtrc.jsonc` in a
 * folder above it is formatted by the repo's `oxfmt`, and any other file by prettier. The choice
 * follows the files rather than an option, because the repo's own format script reads the same
 * files, and a generator that picked differently would disagree with it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The generated text for each file, by path: absolute, or relative to `root`. */
export type GeneratedFiles = Readonly<Record<string, string>>;

export interface WriteOptions {
  /** What a relative path in `files` starts from, usually the repo root. Default: the working directory. */
  root?: string;
  /** Write nothing, and list the files that would change. */
  check?: boolean;
}

/** Paths as `files` spells them, so a message can print them as they are. */
export interface WriteResult {
  /** Files that were missing or different and were written. Always empty when checking. */
  written: string[];
  /** Files that are missing or differ from what the API says today. Always empty when writing. */
  stale: string[];
}

/**
 * Formats each file with the formatter and config that apply at its path (oxfmt when an
 * `.oxfmtrc.json` or `.oxfmtrc.jsonc` sits above it, prettier otherwise), then writes it. With
 * `check`, it writes nothing and lists the files that would change.
 *
 * ```ts
 * const { stale } = await writeGenerated(files, { root, check: process.argv.includes("--check") });
 * if (stale.length > 0) {
 *   console.error(`Out of date:\n  ${stale.join("\n  ")}\nRun \`bun run sdk:gen\` and commit.`);
 *   process.exitCode = 1;
 * }
 * ```
 */
export async function writeGenerated(
  files: GeneratedFiles,
  { root = ".", check = false }: WriteOptions = {},
): Promise<WriteResult> {
  const result: WriteResult = { written: [], stale: [] };
  for (const [name, text] of Object.entries(files)) {
    const path = resolve(root, name);
    const formatted = await formatFile(path, text, resolve(root));
    if (readOrNull(path) === formatted) continue;
    if (check) {
      result.stale.push(name);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, formatted);
    result.written.push(name);
  }
  return result;
}

/** The first of `names` found in `from` or the nearest folder above it, as a path, or null. */
function findUp(from: string, names: readonly string[]): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    for (const name of names) {
      const found = join(dir, name);
      if (existsSync(found)) return found;
    }
    if (dirname(dir) === dir) return null;
  }
}

async function formatFile(path: string, text: string, root: string): Promise<string> {
  // oxfmt reads its config from the path it is given, so this looks where it will look.
  const oxfmtConfig = findUp(dirname(path), [".oxfmtrc.json", ".oxfmtrc.jsonc"]);
  if (oxfmtConfig !== null) return formatWithOxfmt(path, text, root, oxfmtConfig);

  // Imported here, so a repo that formats with oxfmt and has no prettier never loads it.
  const prettier = await import("prettier").catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ERR_MODULE_NOT_FOUND")
      throw new Error(
        `Cannot format ${path}: there is no .oxfmtrc.json or .oxfmtrc.jsonc above it, so sdkgen ` +
          "uses prettier, and prettier is not installed. Add prettier as a devDependency, or add " +
          "oxfmt and an .oxfmtrc.json.",
        { cause: err },
      );
    throw err;
  });
  return prettier.format(text, { ...(await prettier.resolveConfig(path)), filepath: path });
}

/** Runs the repo's own oxfmt, found from `root`, with the text on stdin. */
function formatWithOxfmt(path: string, text: string, root: string, config: string): string {
  const bin = findUp(root, ["node_modules/.bin/oxfmt"]);
  if (bin === null)
    throw new Error(
      `Cannot format ${path}: ${config} says to use oxfmt, but node_modules/.bin/oxfmt is not ` +
        `installed at or above ${root}. Add oxfmt as a devDependency (\`bun add -d oxfmt\`).`,
    );
  // The output is as big as the generated file, so the default 1 MiB limit is not a safe cap.
  const run = spawnSync(bin, ["--stdin-filepath", path], {
    input: text,
    encoding: "utf8",
    maxBuffer: Infinity,
  });
  if (run.error) throw new Error(`Cannot run ${bin} for ${path}: ${run.error.message}`);
  if (run.status !== 0)
    throw new Error(`oxfmt could not format ${path} (exit ${String(run.status)}):\n${run.stderr}`);
  return run.stdout;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    // Missing is stale. Anything else, such as a permission error, is not an answer to "is it
    // current", so it throws.
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}
