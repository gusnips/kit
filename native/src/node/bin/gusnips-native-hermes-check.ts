#!/usr/bin/env node
/**
 * gusnips-native-hermes-check: `checkHermes` from the command line, for an app's own script.
 *
 * Scoped like every bin in this repo: a bare name belongs to whoever registers it on npm, and
 * `bunx` would download and run theirs.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkHermes, type HermesPlatform } from "../hermes.ts";

const HELP = `gusnips-native-hermes-check: compile the app's production bundle with Hermes, without Xcode.

Usage: gusnips-native-hermes-check [options]

  --root <dir>         the app's folder (default: the current folder)
  --entry <file>       the bundle's entry, from the app's folder (default: index.js)
  --platform <name>    ios or android (default: both)
  -h, --help           show this

It makes the bundle a release build makes, then runs the app's hermesc over it, so syntax Hermes
refuses fails here instead of in an archive. A bundle takes minutes: run it before a release or in
CI, not on every save. Missing runtime APIs still need a phone.
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      entry: { type: "string" },
      platform: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const platforms = parsePlatform(values.platform);
  const { problems } = await checkHermes({
    root: resolve(values.root ?? "."),
    entry: values.entry,
    platforms,
  });
  if (problems.length === 0) {
    console.log(`hermes check: the ${platforms.join(" and ")} bundles compile.`);
    return 0;
  }
  for (const problem of problems)
    console.error(
      `${problem.file}:${problem.line}:${problem.column}: ${problem.message} (${problem.platform})`,
    );
  console.error(`hermes check: ${problems.length} problem(s). Hermes would refuse this bundle.`);
  return 1;
}

function parsePlatform(value: string | undefined): HermesPlatform[] {
  if (value === undefined) return ["ios", "android"];
  if (value === "ios" || value === "android") return [value];
  throw new Error(`--platform is ios or android, not "${value}".`);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
