#!/usr/bin/env node
/**
 * gusnips-native-css: `buildNativeCss` from the command line, for an app's `start` script.
 *
 * Scoped like every bin in this repo: a bare name belongs to whoever registers it on npm, and
 * `bunx` would download and run theirs.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildNativeCss, type PaletteEntry } from "../css.ts";

const HELP = `gusnips-native-css: compile global.css for React Native, before Metro starts.

Usage: gusnips-native-css [options]

  --root <dir>       the app's folder (default: the current folder)
  --input <file>     the Tailwind entry, from the app's folder (default: global.css)
  --out <dir>        where stylesheet.ts goes (default: src/generated)
  --palette <file>   a JSON file naming colours for code that cannot take a className:
                     { "text": { "light": "text-ink", "dark": "dark:text-ink-dark" } }
                     writes colors.ts beside stylesheet.ts
  --rem <px>         pixels per rem (default: 16, as on the web)
  -h, --help         show this

Run it before Metro, in the same script: "start": "gusnips-native-css && react-native start"
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      input: { type: "string" },
      out: { type: "string" },
      palette: { type: "string" },
      rem: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const root = resolve(values.root ?? ".");
  const result = await buildNativeCss({
    root,
    input: values.input,
    outDir: values.out,
    rem: values.rem === undefined ? undefined : Number(values.rem),
    palette: values.palette === undefined ? undefined : await readPalette(resolve(values.palette)),
  });
  console.log(`native css: ${result.classes} classes → ${result.files.join(", ")}`);
  return 0;
}

/** The palette file is the app's own, but a typo in it should read as one, not as a crash. */
async function readPalette(file: string): Promise<Record<string, PaletteEntry>> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));
  const palette: Record<string, PaletteEntry> = {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} must hold an object of colour names.`);
  for (const [name, entry] of Object.entries(parsed)) {
    const light: unknown = entry?.light;
    const dark: unknown = entry?.dark;
    if (typeof light !== "string" || typeof dark !== "string")
      throw new Error(
        `${file}: "${name}" needs a "light" and a "dark" class, such as ` +
          '{ "light": "text-ink", "dark": "dark:text-ink-dark" }.',
      );
    palette[name] = { light, dark };
  }
  return palette;
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
