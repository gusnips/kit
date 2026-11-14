/**
 * Does the app's JavaScript compile for Hermes? Answered without Xcode or Gradle.
 *
 * A release build runs `hermesc` over the bundle, so syntax Hermes refuses fails there: in the
 * archive step, minutes into a build, or in a CI that has no Mac. This runs the same two steps on
 * the command line, from the app's folder:
 *
 *   1. React Native's own `bundle` command makes the production bundle and its source map, the way
 *      the release build does;
 *   2. the app's `hermes-compiler` compiles it, and each error is pointed back at the app's source
 *      through the source map.
 *
 * It finds what the compiler finds: syntax Hermes does not parse (async generators, the regex `v`
 * flag) and regex literals it refuses. A missing runtime API (`Array.prototype.findLast`, an `Intl`
 * option) or a pattern built at runtime with `new RegExp` compiles fine and only fails on a phone.
 *
 * Both tools are resolved from the APP's folder, like the CSS build: the bundle has to be the one
 * the app's React Native makes, and the compiler the one its release build runs.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire, SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type HermesPlatform = "ios" | "android";

export interface HermesCheckOptions {
  /** The app's folder. Default: the current folder. */
  root?: string;
  /** The bundle's entry, from the app's folder. Default: `index.js`. */
  entry?: string;
  /** Which bundles to make. Default: both, because `.ios.ts` and `.android.ts` files differ. */
  platforms?: readonly HermesPlatform[];
}

export interface HermesProblem {
  platform: HermesPlatform;
  /** What hermesc said, such as `async generators are unsupported`. */
  message: string;
  /** The app's file, relative to its folder, when the source map knows it. Else the bundle's. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

/**
 * ```ts
 * const { problems } = await checkHermes(); // [] when every bundle compiles
 * ```
 */
export async function checkHermes(
  options: HermesCheckOptions = {},
): Promise<{ problems: HermesProblem[] }> {
  const root = resolve(options.root ?? ".");
  const entry = options.entry ?? "index.js";
  const fromApp = createRequire(join(root, "package.json"));
  // Both before the bundle, so a missing package fails in a moment rather than after minutes.
  const cli = resolveIn(fromApp, "react-native/cli.js", "react-native");
  const hermesc = hermescPath(
    resolveIn(fromApp, "hermes-compiler/package.json", "hermes-compiler"),
  );

  const problems: HermesProblem[] = [];
  for (const platform of options.platforms ?? ["ios", "android"]) {
    // Out of the app's tree, so the check writes nothing into the app.
    const work = await mkdtemp(join(tmpdir(), `gusnips-native-hermes-${platform}-`));
    const bundle = join(work, "index.bundle");
    const map = join(work, "index.bundle.map");
    const made = spawnSync(
      process.execPath,
      [
        cli,
        "bundle",
        `--platform=${platform}`,
        "--dev=false",
        "--minify=false",
        `--entry-file=${entry}`,
        `--bundle-output=${bundle}`,
        `--sourcemap-output=${map}`,
      ],
      // A cold Metro cache takes minutes on a large app. With no deadline a hung bundler holds CI.
      { cwd: root, encoding: "utf-8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (made.error !== undefined)
      throw new Error(`react-native bundle did not finish: ${made.error.message}`);
    if (made.status !== 0)
      throw new Error(
        `react-native bundle failed for ${platform}, before Hermes saw anything:\n` +
          tail(`${made.stdout}\n${made.stderr}`),
      );

    const compiled = spawnSync(
      hermesc,
      ["-emit-binary", `-out=${join(work, "index.hbc")}`, "-w", bundle],
      { encoding: "utf-8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (compiled.error !== undefined)
      throw new Error(`hermesc did not finish: ${compiled.error.message}`);
    if (compiled.status !== 0) {
      const found = parseHermesErrors(compiled.stderr);
      // An exit with nothing we can read is still a failure, and the raw output is the clue.
      if (found.length === 0)
        throw new Error(`hermesc failed for ${platform}:\n${tail(compiled.stderr)}`);
      const sourceMap = new SourceMap(JSON.parse(await readFile(map, "utf-8")));
      for (const error of found)
        problems.push({ platform, ...toSource(error, sourceMap, root, bundle) });
    }
    await rm(work, { recursive: true, force: true });
  }
  return { problems };
}

interface HermesError {
  message: string;
  line: number;
  column: number;
}

/** hermesc writes `<file>:<line>:<column>: error: <message>`, then the line and a caret. */
export function parseHermesErrors(stderr: string): HermesError[] {
  const errors: HermesError[] = [];
  for (const [, line, column, message] of stderr.matchAll(/^.*?:(\d+):(\d+): error: (.*)$/gm))
    if (line !== undefined && column !== undefined && message !== undefined)
      errors.push({ message, line: Number(line), column: Number(column) });
  return errors;
}

/** Where a bundle position came from. A position the map does not cover stays in the bundle. */
export function toSource(
  error: HermesError,
  sourceMap: Pick<SourceMap, "findEntry">,
  root: string,
  bundle: string,
): Omit<HermesProblem, "platform"> {
  const found = sourceMap.findEntry(error.line - 1, error.column - 1);
  // `findEntry` answers the nearest mapping before the position, even from an earlier line, and
  // that would name a file the error is not in. Code Metro generated (a JSON module, the prelude)
  // has segments with no source at all.
  if (
    !("originalSource" in found) ||
    typeof found.originalSource !== "string" ||
    found.generatedLine !== error.line - 1
  )
    return { message: error.message, file: bundle, line: error.line, column: error.column };
  const source = found.originalSource;
  return {
    message: error.message,
    file: isAbsolute(source) ? relative(root, source) : source,
    line: found.originalLine + 1,
    column: found.originalColumn + 1,
  };
}

function resolveIn(fromApp: NodeRequire, path: string, name: string): string {
  try {
    return fromApp.resolve(path);
  } catch {
    throw new Error(
      `${name} is not installed in the app. gusnips-native-hermes-check runs the app's own ` +
        `copy: bun add ${name === "react-native" ? name : `-d ${name}`}`,
    );
  }
}

/** hermes-compiler ships one binary per desktop platform, in a folder named for it. */
function hermescPath(manifest: string): string {
  const folder = join(dirname(manifest), "hermesc");
  switch (process.platform) {
    case "darwin":
      return join(folder, "osx-bin", "hermesc");
    case "linux":
      return join(folder, "linux64-bin", "hermesc");
    case "win32":
      return join(folder, "win64-bin", "hermesc.exe");
    default:
      throw new Error(`hermes-compiler has no hermesc for ${process.platform}.`);
  }
}

function tail(output: string): string {
  return output.trim().split("\n").slice(-30).join("\n");
}
