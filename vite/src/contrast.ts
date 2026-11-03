/**
 * The contrast gate: what a compiler cannot see in a theme and a set of class strings, checked
 * where CI runs.
 *
 * Eight repos wrote this, in two halves that never met: one half measured token values (a
 * control floor, `var()` chains), the other read class strings (untokened colours, the hover
 * rung). Each half passed what the other would have caught, so this is the merge — one compile,
 * both readings.
 *
 * The approach is the tokens package's compile check, extended to an adopter's values rather
 * than duplicated beside it: write a fixture holding every class the sources use, run the real
 * Tailwind CLI over the adopter's own entry, and read the CSS that comes back. The exit code
 * proves nothing; the assertions below are the test. What cannot be imported is the reason:
 * `tokens/` is a leaf with no JavaScript, so the few pure helpers this shares with its script
 * (luminance, the rule lookup) are restated here, with their provenance, rather than reached
 * for across the boundary.
 *
 * What this checks:
 *
 * - **floor**: `--color-input` clears 3:1 against `--color-background` in both modes (WCAG
 *   1.4.11 — it is a control boundary), and `--color-foreground` clears 4.5:1. Three adopters
 *   failed the first, all under it, none visibly broken on screen.
 * - **retune**: `--color-primary` carries its own dark value. Holding one brand colour across
 *   both modes lands the fill on the 3:1 line instead of clear of it.
 * - **rebind**: when a `.dark` block exists, every token is rebound in it. The one that rots.
 * - **untokened**: every colour a scanned class paints resolves to a token the adopter's own
 *   `@theme` declares. `text-white`, `bg-black/40`, `border-gray-300` all read a default-palette
 *   rung instead — correct in one mode and unreadable in the other.
 * - **hover**: a state variant painting the same fill its base already has changes nothing.
 * - **dead**: a class that compiles to no rule at all — a token Tailwind does not have, or a
 *   name the scanner caught half of. A warning: dynamic construction reads the same way.
 *
 * `checkContrast` is the Tailwind reading. `checkTokenPairs` (further down) is the other one, for
 * an app whose colours are plain CSS custom properties: it reads a light block and a dark block as
 * text, holds a list of pairs to a floor in both, and reports through the same problems and the
 * same formatter. It adds two rules:
 *
 * - **missing**: a colour one theme declares and the other does not, or a pair that names a token
 *   neither declares. A typo in a pair would otherwise read as a pair that passes.
 * - **mirror**: the system fallback (the dark colours repeated under `prefers-color-scheme` for a
 *   page that has chosen no theme) differs from the dark block, or sits outside that query.
 *
 * Runs on node and bun: `fs.promises.glob`, never Bun's `Glob`, and no `import.meta.dir`.
 * `checkContrast` needs `@tailwindcss/cli` installed where it runs (an optional peer, reachable
 * only from `@gusnips/vite/contrast`), because the fixture is compiled, not guessed.
 * `checkTokenPairs` compiles nothing and needs no peer.
 */
import { spawnSync } from "node:child_process";
import { glob, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ContrastBundle {
  /** Shown beside every problem: `"apps/web"`. */
  name: string;
  /** The CSS file holding the adopter's `@theme`, relative to `root`. */
  entry: string;
  /** Source holding class strings, as globs relative to `root`. Tests are skipped. */
  sources: readonly string[];
  /** Classes the untokened rule skips, e.g. `[/^bg-brand-/]` for a marketing page that means it. */
  allow?: readonly RegExp[];
}

export interface CheckContrastOptions {
  /** What `entry` and `sources` are relative to. Default: the working directory. */
  root?: string;
}

export type ContrastRule =
  "load" | "floor" | "retune" | "rebind" | "untokened" | "hover" | "dead" | "missing" | "mirror";

export interface ContrastProblem {
  rule: ContrastRule;
  /** A warning is shown and does not fail the gate. */
  level: "error" | "warning";
  bundle: string;
  class?: string;
  /** `file:line`, for a problem found in source. */
  at?: string;
  message: string;
}

export interface ContrastReport {
  problems: ContrastProblem[];
}

// ── Colour ────────────────────────────────────────────────────────────────────
// Restated from the tokens compile check (`tokens/scripts/compile-check.ts`), which this gate
// extends: a leaf ships no JavaScript, so there is nothing to import.

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** `#fff` → `#ffffff`. Anything else hex-shaped passes through; anything else is null. */
function normalizeHex(value: string): string | null {
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
  return short === null
    ? null
    : `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
}

// ── Theme ─────────────────────────────────────────────────────────────────────

/** `--color-*` declarations out of every `@theme { … }` block. Values stay raw. */
function themeBlock(entry: string, at: RegExp): Map<string, string> {
  const found = new Map<string, string>();
  for (const block of entry.matchAll(at)) {
    for (const match of (block[1] ?? "").matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) {
      found.set(match[1] ?? "", (match[2] ?? "").trim());
    }
  }
  return found;
}

/**
 * Follow a `var()` chain to the literal it bottoms out at. Indirection is legitimate — a token
 * may point at another — so only the terminal is measured, never the link. A cycle, a name the
 * theme never declares, or a fallback that is itself unresolvable measures as nothing, which the
 * floor reports rather than guesses.
 */
function resolveChain(
  value: string,
  map: Map<string, string>,
  seen: Set<string> = new Set(),
): string | null {
  const ref = /^\s*var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+?))?\s*\)\s*$/.exec(value);
  if (ref === null) return value;
  const target = map.get(ref[1] ?? "");
  if (target === undefined || seen.has(ref[1] ?? "")) {
    return ref[2] === undefined ? null : resolveChain(ref[2], map, seen);
  }
  seen.add(ref[1] ?? "");
  return resolveChain(target, map, seen);
}

function measured(value: string, map: Map<string, string>): string | null {
  const terminal = resolveChain(value, map);
  return terminal === null ? null : normalizeHex(terminal);
}

// ── Sources ───────────────────────────────────────────────────────────────────

const ATTR = /\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|`((?:[^`$]|\$(?!\{))*)`)/g;
const HELPER = /\b(?:cn|clsx|cva|twMerge|twJoin)\s*\(([^)]*)\)/g;
const STR = /"([^"]*)"|'([^']*)'/g;

/** The 1-based line a character offset falls on. */
function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

const skipped = (file: string): boolean =>
  /(?:^|\/)__tests__\//.test(file) || /\.(test|spec)\.[tj]sx?$/.test(file);

/** Every class string the sources use, with the first `file:line` that uses it. */
async function scanSources(
  root: string,
  patterns: readonly string[],
): Promise<Map<string, { file: string; line: number }[]>> {
  const found = new Map<string, { file: string; line: number }[]>();
  const files = new Set<string>();
  for (const pattern of patterns) {
    for await (const file of glob(pattern, { cwd: root })) {
      if (!skipped(file)) files.add(file);
    }
  }
  const keep = (raw: string, file: string, index: number, source: string): void => {
    for (const cls of raw.split(/\s+/).filter(Boolean)) {
      // A token that would break the fixture's quoting is skipped rather than escaped:
      // Tailwind reads the fixture as TEXT, so an entity would read as a different class.
      if (/["&<>]/.test(cls)) continue;
      const at = { file, line: lineAt(source, index) };
      const seen = found.get(cls);
      if (seen === undefined) found.set(cls, [at]);
      else if (!seen.some((entry) => entry.file === file)) seen.push(at);
    }
  };
  for (const file of [...files].sort()) {
    const source = await readFile(resolve(root, file), "utf8");
    for (const match of source.matchAll(ATTR)) {
      keep(match[1] ?? match[2] ?? match[3] ?? "", file, match.index, source);
    }
    for (const call of source.matchAll(HELPER)) {
      for (const match of (call[1] ?? "").matchAll(STR)) {
        keep(match[1] ?? match[2] ?? "", file, (call.index ?? 0) + (match.index ?? 0), source);
      }
    }
  }
  return found;
}

// ── Compile ───────────────────────────────────────────────────────────────────
// The tokens approach: a fixture holding every class, the real CLI over the adopter's own
// entry, and the CSS that comes back. The fixture is plain text, not HTML — Tailwind reads
// candidates out of the raw bytes, so no quoting can corrupt a class.

/**
 * The body of the first rule whose selector uses `cls` as a whole class name.
 * Follows the tokens compile check: `.text-card` must not match `.text-card-foreground`.
 */
function ruleBody(css: string, cls: string): string | null {
  const selector = `.${cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)}`;
  let from = 0;
  for (;;) {
    const at = css.indexOf(selector, from);
    if (at === -1) return null;
    from = at + selector.length;
    if (/^[-\w\\]/.test(css.slice(from))) continue;
    const open = css.indexOf("{", at);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
    }
    return null;
  }
}

async function compile(entryAbs: string, classes: string[], workDir: string): Promise<string> {
  // `createRequire` and not `import.meta.resolve`: this runs in whatever runtime the adopter's
  // CI uses, and `require.resolve` holds everywhere. Never `import.meta.dir` — it is bun-only.
  const cliPkg = createRequire(fileURLToPath(import.meta.url)).resolve(
    "@tailwindcss/cli/package.json",
  );
  const cli = join(dirname(cliPkg), "dist", "index.mjs");

  // The entry must live where `tailwindcss` resolves: beside the adopter's tree, which the
  // workdir is. The adopter's own entry is imported by absolute path, so its `@source`
  // directives — relative to the file it is reading — resolve the way its build resolves them.
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "fixture.txt"), `${[...classes].sort().join("\n")}\n`);
  await writeFile(
    join(workDir, "entry.css"),
    `@import "tailwindcss";\n@import "${entryAbs}";\n@source "./fixture.txt";\n`,
  );

  const out = join(workDir, "out.css");
  const run = spawnSync(process.execPath, [cli, "-i", join(workDir, "entry.css"), "-o", out], {
    cwd: workDir,
    encoding: "utf-8",
    // The compile takes seconds. The CLI has hung once with no output, and with no deadline
    // that held a gate open for five minutes instead of failing it.
    timeout: 120_000,
  });
  if (run.error !== undefined) throw new Error(`tailwindcss did not finish: ${run.error.message}`);
  if (run.status !== 0) {
    // Left on disk on purpose: the compiled CSS is the first thing you want to read.
    throw new Error(
      `tailwindcss failed to compile ${entryAbs}${run.stderr ? `: ${run.stderr.slice(0, 500)}` : ""} (workdir kept at ${workDir})`,
    );
  }
  const css = await readFile(out, "utf-8");
  await rm(workDir, { recursive: true, force: true });
  return css;
}

// ── The check ─────────────────────────────────────────────────────────────────

const COLOR_PROPS = new Set([
  "color",
  "background-color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "text-decoration-color",
  "fill",
  "stroke",
]);

const LITERAL_COLOR = /#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl|oklch|oklab|lab|lch|color-mix|color)\s*\(/;

/** The first `file:line` that uses a class, for problems found in source. */
function firstAt(
  scanned: Map<string, { file: string; line: number }[]>,
  cls: string,
): string | undefined {
  const at = scanned.get(cls)?.[0];
  return at === undefined ? undefined : `${at.file}:${String(at.line)}`;
}

/** `hover:bg-primary` → `bg-primary`. Every variant prefix comes off, not just the first. */
function stem(cls: string): string {
  return cls.replace(/^(?:[a-z][a-z0-9-]*:)+/, "");
}

function isStateVariant(cls: string): boolean {
  return /^(?:hover|focus|focus-visible|focus-within|active):/.test(cls);
}

async function checkBundle(
  bundle: ContrastBundle,
  options: CheckContrastOptions,
  report: ContrastReport,
): Promise<void> {
  const root = options.root ?? process.cwd();
  const problem = (p: Omit<ContrastProblem, "bundle" | "level"> & { level?: "warning" }): void => {
    report.problems.push({ bundle: bundle.name, level: "error", ...p });
  };

  const entryAbs = resolve(root, bundle.entry);
  const entry = await readFile(entryAbs, "utf8").catch(() => null);
  if (entry === null) {
    // A theme that does not load reads as one with no tokens, which would pass every rule
    // below. It fails here instead — the i18n gate's load rule, for the same reason.
    problem({ rule: "load", message: `${bundle.entry} could not be read` });
    return;
  }

  const light = themeBlock(entry, /@theme\s*\{([^}]*)\}/g);
  const dark = themeBlock(entry, /\.dark\s*\{([^}]*)\}/g);
  const semantic = new Set(light.keys());

  // ── Floors, on the values that actually ship ──
  const floors: Array<[token: string, against: string, floor: number, why: string]> = [
    ["--color-input", "--color-background", 3, "a field border (WCAG 1.4.11)"],
    ["--color-foreground", "--color-background", 4.5, "body copy (WCAG 1.4.3)"],
  ];
  const modes: Array<[mode: string, map: Map<string, string>]> = [["light", light]];
  if (dark.size > 0) modes.push(["dark", dark]);
  for (const [mode, map] of modes) {
    for (const [token, against, floor, why] of floors) {
      const fg = map.has(token) ? measured(map.get(token) ?? "", map) : null;
      const bg = map.has(against) ? measured(map.get(against) ?? "", map) : null;
      if (fg === null || bg === null) {
        problem({
          rule: "floor",
          message:
            `${mode}: cannot measure ${token} on ${against}, because one of them is no longer a ` +
            `hex colour. Keep the values hex, or teach this check the new notation; ` +
            `do not let the floor go unmeasured.`,
        });
        continue;
      }
      const ratio = contrast(fg, bg);
      if (ratio < floor) {
        problem({
          rule: "floor",
          message:
            `${mode}: ${token} (${fg}) on ${against} (${bg}) is ${ratio.toFixed(2)}:1, ` +
            `under the ${floor}:1 floor for ${why}`,
        });
      }
    }
  }

  if (dark.size > 0) {
    for (const name of light.keys()) {
      if (!dark.has(name))
        problem({
          rule: "rebind",
          message: `\`${name}\` is missing from the .dark block, so one mode keeps the light value`,
        });
    }
    // A fill chosen against a white page lands on the 3:1 line on a near-black card instead of
    // clear of it. The day a brand colour truly works in both modes, this is the line that says
    // the contract moved.
    const day = measured(light.get("--color-primary") ?? "", light);
    const night = measured(dark.get("--color-primary") ?? "", dark);
    if (day !== null && night !== null && day === night) {
      problem({
        rule: "retune",
        message:
          `--color-primary (${day}) is the same fill in both modes. Lift it for dark, and ` +
          `flip --color-primary-foreground with it`,
      });
    }
  }

  // ── Classes, against the compiled output ──
  const scanned = await scanSources(root, bundle.sources);
  const classes = [...scanned.keys()];
  let css: string;
  try {
    css = await compile(entryAbs, classes, join(root, ".contrast-check"));
  } catch (error) {
    problem({
      rule: "load",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const allowed = (cls: string): boolean => (bundle.allow ?? []).some((re) => re.test(cls));
  const byStem = new Map<string, Set<string>>();
  for (const cls of classes) {
    const set = byStem.get(stem(cls)) ?? new Set<string>();
    set.add(cls);
    byStem.set(stem(cls), set);
  }

  for (const cls of classes.sort()) {
    const body = ruleBody(css, cls);
    if (body === null) {
      problem({
        rule: "dead",
        level: "warning",
        class: cls,
        at: firstAt(scanned, cls),
        message:
          "compiled to no rule: a token Tailwind does not have, or a class built dynamically",
      });
      continue;
    }
    if (allowed(cls)) continue;
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      const prop = declaration.slice(0, colon).trim();
      if (!COLOR_PROPS.has(prop)) continue;
      const value = declaration.slice(colon + 1);
      const tokens = [...value.matchAll(/var\(\s*(--color-[\w-]+)/g)].map((m) => m[1] ?? "");
      if (tokens.length === 0) {
        if (!LITERAL_COLOR.test(value)) continue;
        for (const { file, line } of scanned.get(cls) ?? []) {
          problem({
            rule: "untokened",
            class: cls,
            at: `${file}:${String(line)}`,
            message: `paints ${prop} with a literal colour. Point it at a theme token instead`,
          });
        }
        continue;
      }
      for (const token of tokens) {
        if (semantic.has(token)) continue;
        for (const { file, line } of scanned.get(cls) ?? []) {
          problem({
            rule: "untokened",
            class: cls,
            at: `${file}:${String(line)}`,
            message:
              `paints ${prop} from \`${token}\`, which the theme never declares. ` +
              `A default-palette rung reads right in one mode and vanishes in the other`,
          });
        }
      }
    }
  }

  // ── The hover rung ──
  for (const [base, variants] of byStem) {
    if (!variants.has(base)) continue;
    for (const variant of [...variants].sort()) {
      if (variant === base || !isStateVariant(variant) || stem(variant) !== base) continue;
      problem({
        rule: "hover",
        level: "warning",
        class: variant,
        at: firstAt(scanned, variant),
        message:
          `paints the same ${base} the base state already has, so the state changes nothing. ` +
          `If these are on different elements, ignore this.`,
      });
    }
  }
}

/**
 * Run the gate over every bundle. Returns what it found rather than printing or exiting, so a
 * repo can add checks of its own to the same report and decide how CI fails:
 *
 * ```ts
 * const report = await checkContrast([{ name: "apps/web", entry: "src/index.css", sources: ["src/**"] }]);
 * console.log(formatContrastReport(report));
 * process.exit(report.problems.some((p) => p.level === "error") ? 1 : 0);
 * ```
 */
export async function checkContrast(
  bundles: readonly ContrastBundle[],
  options: CheckContrastOptions = {},
): Promise<ContrastReport> {
  const report: ContrastReport = { problems: [] };
  for (const bundle of bundles) await checkBundle(bundle, options, report);
  return report;
}

/** The report as lines for a terminal: one per problem, grouped by bundle, and a last line that
 *  says whether the gate passed. */
export function formatContrastReport(report: ContrastReport): string {
  const lines: string[] = [];
  const bundles = [...new Set(report.problems.map((p) => p.bundle))];
  for (const bundle of bundles) {
    lines.push(bundle);
    for (const p of report.problems.filter((q) => q.bundle === bundle)) {
      const where = [p.class, p.at].filter((part) => part !== undefined).join(" ");
      lines.push(
        `  ${p.level === "error" ? "✖" : "⚠"} ${p.rule}: ${where}${where === "" ? "" : " "}${p.message}`,
      );
    }
  }
  const errors = report.problems.filter((p) => p.level === "error").length;
  const warnings = report.problems.length - errors;
  lines.push(
    errors === 0
      ? `✔ contrast: no errors${warnings > 0 ? `, ${warnings} warning(s)` : ""}`
      : `✖ contrast: ${errors} error(s)${warnings > 0 ? `, ${warnings} warning(s)` : ""}`,
  );
  return lines.join("\n");
}

// ── Plain CSS tokens ──────────────────────────────────────────────────────────
// The same gate for an app with no Tailwind `@theme`: its colours are custom properties in a
// light block and a dark block, and a list of pairs that must stay readable in both. The file is
// read as text and nothing is compiled, so this reading installs no optional peer.
//
// The limits are stated rather than hidden: hex colours only (a pair that names anything else
// fails as unmeasurable, never passes), blocks found by their selector text, and a block that
// holds another block (nested CSS) is not read. There is no CSS parser here. If themes outgrow
// flat blocks, replace `leafRules` with one.

/** Two custom properties, `[background, foreground]`, written as the CSS names them:
 *  `["--ground", "--ink"]`. The ratio is the same either way round; the order only decides how a
 *  problem reads. */
export type TokenPair = readonly [background: string, foreground: string];

export interface TokenPairsBundle {
  /** Shown beside every problem: `"apps/site"`. */
  name: string;
  /** The stylesheet holding the colour blocks, relative to `root`. */
  css: string;
  /** The selector of the light block. Default `":root"`. It must differ from `dark`. */
  light?: string;
  /** The selector of the dark block: `':root[data-theme="dark"]'`. */
  dark: string;
  /**
   * The selector of the system fallback: the dark colours again, for a page that has chosen no
   * theme, inside `@media (prefers-color-scheme: dark)`: `":root:not([data-theme])"`. It must
   * hold exactly the dark block's tokens and values. Leave it off when there is none.
   */
  system?: string;
  /** Pairs read as text. Held to `textFloor`. */
  textPairs?: readonly TokenPair[];
  /** Pairs that are not text: borders, focus rings, icons. Held to `nonTextFloor`. */
  nonTextPairs?: readonly TokenPair[];
  /** Default 4.5 (WCAG 1.4.3). */
  textFloor?: number;
  /** Default 3 (WCAG 1.4.11). */
  nonTextFloor?: number;
}

/** The hex colours of each theme, `--ground` → `#ffffff`, for a check of your own. */
export interface TokenThemes {
  light: Map<string, string>;
  dark: Map<string, string>;
}

interface TokenDecl {
  value: string;
  line: number;
}

interface CssRule {
  selectors: string[];
  /** The at-rules around it, outermost first: `@media screen @media (prefers-color-scheme: dark)`. */
  within: string;
  tokens: Map<string, TokenDecl>;
}

interface TokenBlock {
  tokens: Map<string, TokenDecl>;
  /** `within` of every block that matched, since one selector may be written twice. */
  within: string[];
}

interface TokenBlocks {
  light: TokenBlock;
  dark: TokenBlock;
  /** `null` when the bundle names no system block, or names one that is not in the file. */
  system: TokenBlock | null;
}

const PREFERS_DARK = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/;

/** `:root[data-theme='dark']` and `:root[data-theme="dark"]` are the same selector. */
const selectorOf = (text: string): string => text.replace(/\s+/g, " ").replace(/'/g, '"').trim();

/** The comparable form of a value: `#FFF` and `#ffffff` are one colour. */
const canonical = (value: string): string =>
  normalizeHex(value) ?? value.replace(/\s+/g, " ").toLowerCase();

/**
 * Every innermost `selector { … }` block with the at-rules around it, and the custom properties
 * it declares. Text, not syntax: a brace or semicolon inside a string or `url()` is not understood.
 */
function leafRules(css: string): CssRule[] {
  // Comments become spaces, so a `{` in one is not a block and every offset still names its line.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const rules: CssRule[] = [];
  const open: Array<{ prelude: string; bodyAt: number; nested: boolean }> = [];
  let preludeFrom = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{") {
      const parent = open.at(-1);
      if (parent !== undefined) parent.nested = true;
      open.push({ prelude: source.slice(preludeFrom, i).trim(), bodyAt: i + 1, nested: false });
      preludeFrom = i + 1;
    } else if (char === "}") {
      const block = open.pop();
      preludeFrom = i + 1;
      if (block === undefined || block.nested || block.prelude.startsWith("@")) continue;
      const tokens = new Map<string, TokenDecl>();
      for (const match of source.slice(block.bodyAt, i).matchAll(/(--[\w-]+)\s*:\s*([^;]*)/g)) {
        tokens.set(match[1] ?? "", {
          value: (match[2] ?? "").trim(),
          line: lineAt(source, block.bodyAt + match.index),
        });
      }
      rules.push({
        selectors: block.prelude.split(",").map(selectorOf),
        within: open
          .map((parent) => parent.prelude)
          .filter((prelude) => prelude.startsWith("@"))
          .join(" "),
        tokens,
      });
    } else if (char === ";") {
      preludeFrom = i + 1;
    }
  }
  return rules;
}

/** Every block written with this selector, merged: a later token wins, as it does in CSS. */
function blockOf(rules: readonly CssRule[], selector: string): TokenBlock | null {
  const wanted = selectorOf(selector);
  const found = rules.filter((rule) => rule.selectors.includes(wanted));
  if (found.length === 0) return null;
  const tokens = new Map<string, TokenDecl>();
  for (const rule of found) for (const [name, decl] of rule.tokens) tokens.set(name, decl);
  return { tokens, within: found.map((rule) => rule.within) };
}

/** Throws when the file or a block the bundle names is not there. The system block may be absent:
 *  whether that is a problem is the check's question, not the loader's. */
async function readTokenBlocks(
  bundle: Pick<TokenPairsBundle, "css" | "light" | "dark" | "system">,
  root: string,
): Promise<TokenBlocks> {
  const css = await readFile(resolve(root, bundle.css), "utf8").catch(() => null);
  // A stylesheet that does not load reads as one with no tokens, which would pass every rule
  // below. It fails instead, the same reason `checkContrast` has a load rule.
  if (css === null) throw new Error(`${bundle.css} could not be read`);
  const rules = leafRules(css);
  const required = (label: string, selector: string): TokenBlock => {
    const block = blockOf(rules, selector);
    if (block === null) {
      throw new Error(
        `${bundle.css} has no \`${selector}\` block for the ${label} colours. A block is found by ` +
          `its selector text, inside any @media, and holds declarations only`,
      );
    }
    return block;
  };
  const lightSelector = bundle.light ?? ":root";
  if (selectorOf(lightSelector) === selectorOf(bundle.dark)) {
    throw new Error(`the light and dark selectors are both \`${lightSelector}\`; they must differ`);
  }
  return {
    light: required("light", lightSelector),
    dark: required("dark", bundle.dark),
    system: bundle.system === undefined ? null : blockOf(rules, bundle.system),
  };
}

/** The tokens whose value is a hex colour, as `#rrggbb`. Type and geometry are left out. */
function hexTokens(tokens: ReadonlyMap<string, TokenDecl>): Map<string, string> {
  const hex = new Map<string, string>();
  for (const [name, { value }] of tokens) {
    const colour = normalizeHex(value);
    if (colour !== null) hex.set(name, colour);
  }
  return hex;
}

/**
 * The two palettes of a bundle as hex maps, for a check of your own that needs the colours
 * (the browser's toolbar colour should be the page's ground, in each theme):
 *
 * ```ts
 * const { light, dark } = await loadTokenThemes({ css: "src/tokens.css", dark: '[data-theme="dark"]' });
 * light.get("--ground"); // "#ffffff"
 * ```
 *
 * Throws, saying what is missing, when the file or one of the two blocks is not there.
 */
export async function loadTokenThemes(
  bundle: Pick<TokenPairsBundle, "css" | "light" | "dark">,
  options: CheckContrastOptions = {},
): Promise<TokenThemes> {
  const { light, dark } = await readTokenBlocks(bundle, options.root ?? process.cwd());
  return { light: hexTokens(light.tokens), dark: hexTokens(dark.tokens) };
}

async function checkTokenBundle(
  bundle: TokenPairsBundle,
  options: CheckContrastOptions,
  report: ContrastReport,
): Promise<void> {
  const problem = (p: Omit<ContrastProblem, "bundle" | "level">): void => {
    report.problems.push({ bundle: bundle.name, level: "error", ...p });
  };
  const at = (decl: TokenDecl | undefined): string =>
    decl === undefined ? bundle.css : `${bundle.css}:${String(decl.line)}`;

  let blocks: TokenBlocks;
  try {
    blocks = await readTokenBlocks(bundle, options.root ?? process.cwd());
  } catch (error) {
    problem({ rule: "load", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  const { light, dark, system } = blocks;
  const themes: Array<[mode: string, tokens: Map<string, TokenDecl>]> = [
    ["light", light.tokens],
    ["dark", dark.tokens],
  ];
  const textPairs = bundle.textPairs ?? [];
  const nonTextPairs = bundle.nonTextPairs ?? [];

  // ── Every colour has both themes, and every pair names a real token ──
  const wanted = new Set([
    ...hexTokens(light.tokens).keys(),
    ...hexTokens(dark.tokens).keys(),
    ...[...textPairs, ...nonTextPairs].flat(),
  ]);
  for (const token of wanted) {
    const inLight = light.tokens.get(token);
    const inDark = dark.tokens.get(token);
    if (inLight !== undefined && inDark !== undefined) continue;
    if (inLight === undefined && inDark === undefined) {
      problem({
        rule: "missing",
        at: bundle.css,
        message:
          `a pair names \`${token}\`, which neither the light nor the dark block declares` +
          (token.startsWith("--") ? "" : ". Custom property names start with --"),
      });
      continue;
    }
    const [have, lack] = inLight === undefined ? ["dark", "light"] : ["light", "dark"];
    problem({
      rule: "missing",
      at: at(inLight ?? inDark),
      message:
        `\`${token}\` is in the ${have} block but not in the ${lack} block. Declare it in both, ` +
        `even when the colour is the same, so each theme says what it means`,
    });
  }

  // ── The pairs, on the values that ship in each theme ──
  // A token missing from a theme was reported above, so its pairs are skipped here, not repeated.
  const unmeasurable = new Set<string>();
  const cannotMeasure = (mode: string, token: string, decl: TokenDecl): void => {
    if (unmeasurable.has(`${mode}:${token}`)) return;
    unmeasurable.add(`${mode}:${token}`);
    problem({
      rule: "floor",
      at: at(decl),
      message:
        `${mode}: cannot measure ${token} (${decl.value}), because it is not a hex colour. ` +
        `Keep the values hex, or teach this check the new notation; ` +
        `do not let a pair go unmeasured.`,
    });
  };
  const measure = (pairs: readonly TokenPair[], floor: number, why: string): void => {
    for (const [background, foreground] of pairs) {
      for (const [mode, tokens] of themes) {
        const bg = tokens.get(background);
        const fg = tokens.get(foreground);
        if (bg === undefined || fg === undefined) continue;
        const bgHex = normalizeHex(bg.value);
        const fgHex = normalizeHex(fg.value);
        if (bgHex === null || fgHex === null) {
          if (bgHex === null) cannotMeasure(mode, background, bg);
          if (fgHex === null) cannotMeasure(mode, foreground, fg);
          continue;
        }
        const ratio = contrast(fgHex, bgHex);
        if (ratio < floor) {
          problem({
            rule: "floor",
            at: at(fg),
            message:
              `${mode}: ${foreground} (${fgHex}) on ${background} (${bgHex}) is ` +
              `${ratio.toFixed(2)}:1, under the ${floor}:1 floor for ${why}`,
          });
        }
      }
    }
  };
  measure(textPairs, bundle.textFloor ?? 4.5, "text (WCAG 1.4.3)");
  measure(nonTextPairs, bundle.nonTextFloor ?? 3, "a control or icon (WCAG 1.4.11)");

  // ── The system fallback says what the dark block says ──
  if (bundle.system === undefined) return;
  const mirror = (decl: TokenDecl | undefined, message: string): void =>
    problem({ rule: "mirror", at: at(decl), message });
  if (system === null) {
    mirror(
      undefined,
      `no \`${bundle.system}\` block for the system fallback. Without it a page that has ` +
        `chosen no theme stays light on a dark system`,
    );
    return;
  }
  if (!system.within.every((within) => PREFERS_DARK.test(within))) {
    mirror(
      [...system.tokens.values()][0],
      `\`${bundle.system}\` is not inside @media (prefers-color-scheme: dark), so it paints ` +
        `the dark colours for everyone who has chosen no theme`,
    );
  }
  for (const token of new Set([...dark.tokens.keys(), ...system.tokens.keys()])) {
    const chosen = dark.tokens.get(token);
    const followed = system.tokens.get(token);
    if (chosen !== undefined && followed !== undefined) {
      if (canonical(chosen.value) !== canonical(followed.value)) {
        mirror(
          followed,
          `\`${token}\` is ${chosen.value} in the dark block but ${followed.value} in the system block`,
        );
      }
    } else if (chosen !== undefined) {
      mirror(chosen, `\`${token}\` is in the dark block but not in the system block`);
    } else {
      mirror(followed, `\`${token}\` is in the system block but not in the dark block`);
    }
  }
}

/**
 * The plain-CSS gate: for each stylesheet, the contrast of every pair in both themes, a token
 * both themes have, and a system fallback that matches the dark block. Returns what it found,
 * the same report `checkContrast` returns, so `formatContrastReport` prints either and a repo
 * can join the two (`report.problems.push(...other.problems)`) and fail CI once.
 *
 * ```ts
 * const report = await checkTokenPairs([
 *   { name: "site", css: "src/tokens.css", dark: ':root[data-theme="dark"]', textPairs: [["--ground", "--ink"]] },
 * ]);
 * console.log(formatContrastReport(report));
 * ```
 */
export async function checkTokenPairs(
  bundles: readonly TokenPairsBundle[],
  options: CheckContrastOptions = {},
): Promise<ContrastReport> {
  const report: ContrastReport = { problems: [] };
  for (const bundle of bundles) await checkTokenBundle(bundle, options, report);
  return report;
}
