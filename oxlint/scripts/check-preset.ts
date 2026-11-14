#!/usr/bin/env bun
/**
 * Does each preset still catch what it is for?
 *
 * oxlint answers a rule it does not know, or a rule that is off by default, with silence. A
 * preset line that names a rule oxlint never had, or a pedantic rule that someone deleted, changes
 * no exit code and no message: the repo that extends it just stops being checked. So this runs the
 * INSTALLED oxlint over a small fixture through each preset, the way a repo extends it, and
 * compares the diagnostics line by line. The exit code proves nothing; the list is the test.
 *
 * Three things are pinned:
 *
 * - the fixture's exact diagnostics, per preset. `base.json` must flag the `any`, the unused
 *   variable and the seventeen rules ESLint's `recommended` sets turn on that oxlint leaves
 *   outside its `correctness` category (typescript-eslint's `eslint-recommended` layer adds
 *   four of them: `no-var`, `prefer-const`, `prefer-rest-params`, `prefer-spread`); must NOT flag an unused `_`-prefixed argument or variable;
 *   and must say nothing about React. `react.json` adds the conditional hook and the stale effect
 *   dependency.
 * - the severity of every React rule `eslint-plugin-react-hooks@7`'s `recommended` sets, read back
 *   from `--print-config`. A fixture cannot trip all of them cheaply, and a rule that oxlint
 *   renames shows up here as `undefined` instead of as a pass.
 * - the positive control: the same fixture through a copy of each preset with its rules deleted
 *   must NOT match. A check that passes on an empty preset is not looking at the preset.
 *
 * Run: bun run scripts/check-preset.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE = join(import.meta.dirname, "..");
// `bin/oxlint` is a node script, and the package's exports map does not list it, so find the
// package by its entry and walk back to the bin.
const OXLINT = join(
  dirname(createRequire(import.meta.url).resolve("oxlint")),
  "..",
  "bin",
  "oxlint",
);

const FIXTURE: Record<string, string> = {
  // An unused `_` argument and `_` variable must pass; the unused `unused` and the `any` must not.
  "base.ts": `export const loose: any = 1;
const unused = 2;
export function keep(_ignored: number, used: number): number {
  return used;
}
const _kept = 3;
`,
  // One line per rule that ESLint's recommended sets enable and oxlint's correctness category lacks.
  "recommended.ts": `// @ts-ignore
export const list = Array(1, 2);
export function pick(n: number): number {
  switch (n) {
    case 1:
      const one = 1;
      return one;
    case 2:
      n += 1;
    case 3:
      return n;
    default:
      return 0;
  }
}
try {
  pick(1);
} catch {}
export const has = (o: object) => o.hasOwnProperty("x");
export const spaced = /a  b/;
export const split = pick
(1);
export type Nothing = {};
export namespace Space {
  export const x = 1;
}
export const fs = require("fs");
export function same<T extends unknown>(value: T): T {
  return value;
}
export const call: Function = () => 1;
export var legacy = 1;
let never = 2;
export const copy = never;
export function rest(): number {
  return Array.from(arguments).length;
}
export const spread = (list: number[]) => Math.max.apply(Math, list);
pick;
`,
  "hooks.tsx": `import { useEffect, useState } from "react";
import { Trans } from "react-i18next";

export function Conditional({ open }: { open: boolean }) {
  if (open) {
    const [seen] = useState(false);
    return <p>{String(seen)}</p>;
  }
  return null;
}

export function Stale({ id }: { id: string }) {
  useEffect(() => {
    document.title = id;
  }, []);
  return null;
}

// Both are fine in the app and flagged by oxlint: a \`Trans\` components array has no keys, and
// \`new Date()\` is not one of the impure calls the plugin reports.
export function Footer() {
  const year = new Date().getFullYear();
  return <Trans components={[<b />, <i />]}>{year}</Trans>;
}
`,
};

const BASE_DIAGNOSTICS = [
  "base.ts:1 error typescript(no-explicit-any)",
  "base.ts:2 error eslint(no-unused-vars)",
  "recommended.ts:1 error typescript(ban-ts-comment)",
  "recommended.ts:2 error eslint(no-array-constructor)",
  "recommended.ts:6 error eslint(no-case-declarations)",
  "recommended.ts:10 error eslint(no-fallthrough)",
  "recommended.ts:18 error eslint(no-empty)",
  "recommended.ts:19 error eslint(no-prototype-builtins)",
  "recommended.ts:20 error eslint(no-regex-spaces)",
  "recommended.ts:22 error eslint(no-unexpected-multiline)",
  "recommended.ts:23 error typescript(no-empty-object-type)",
  "recommended.ts:24 error typescript(no-namespace)",
  "recommended.ts:27 error typescript(no-require-imports)",
  "recommended.ts:28 error typescript(no-unnecessary-type-constraint)",
  "recommended.ts:31 error typescript(no-unsafe-function-type)",
  "recommended.ts:32 error eslint(no-var)",
  "recommended.ts:33 error eslint(prefer-const)",
  "recommended.ts:36 error eslint(prefer-rest-params)",
  "recommended.ts:38 error eslint(prefer-spread)",
  "recommended.ts:39 error eslint(no-unused-expressions)",
];

const REACT_DIAGNOSTICS = [
  "hooks.tsx:6 error react-hooks(rules-of-hooks)",
  "hooks.tsx:14 warning react-hooks(exhaustive-deps)",
];

/** What `eslint-plugin-react-hooks@7`'s `recommended` sets, by the name oxlint gives each rule. */
const REACT_HOOKS_RECOMMENDED: Record<string, string> = {
  "react/rules-of-hooks": "deny",
  "react/exhaustive-deps": "warn",
  "react/static-components": "deny",
  "react/use-memo": "deny",
  "react/preserve-manual-memoization": "deny",
  "react/incompatible-library": "warn",
  "react/immutability": "deny",
  "react/globals": "deny",
  "react/refs": "deny",
  "react/set-state-in-effect": "deny",
  "react/error-boundaries": "deny",
  "react/set-state-in-render": "deny",
};

interface Output {
  diagnostics: {
    code: string;
    severity: string;
    filename: string;
    labels: { span: { line: number } }[];
  }[];
}

/** Runs oxlint in `cwd` and returns stdout, whatever the exit code: errors found is exit 1. */
function oxlint(cwd: string, args: string[]): string {
  const run = spawnSync("node", [OXLINT, ...args], { cwd, encoding: "utf8" });
  if (run.error || run.status === null || run.status > 1)
    throw new Error(`oxlint ${args.join(" ")} failed: ${run.error?.message ?? run.stderr}`);
  return run.stdout;
}

/** The preset files as they are on disk, by file name. */
const SHIPPED = Object.fromEntries(
  ["base.json", "react.json"].map((name) => [name, readFileSync(join(PACKAGE, name), "utf8")]),
);

/**
 * A throwaway repo laid out the way an adopter's is: the preset files in
 * `node_modules/@gusnips/oxlint`, and a `.oxlintrc.json` that is one `extends` line.
 */
function repoExtending(entry: string, presets: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oxlint-preset-"));
  const installed = join(dir, "node_modules", "@gusnips", "oxlint");
  mkdirSync(installed, { recursive: true });
  for (const [name, source] of Object.entries(presets))
    writeFileSync(join(installed, name), source);
  writeFileSync(
    join(dir, ".oxlintrc.json"),
    JSON.stringify({ extends: [`./node_modules/@gusnips/oxlint/${entry}`] }),
  );
  for (const [name, source] of Object.entries(FIXTURE)) writeFileSync(join(dir, name), source);
  return dir;
}

function diagnose(entry: string, presets: Record<string, string> = SHIPPED): string[] {
  const dir = repoExtending(entry, presets);
  try {
    // The fixture files by name: a bare `.` also walks the preset copy in node_modules.
    const out: Output = JSON.parse(
      oxlint(dir, ["-c", ".oxlintrc.json", "-f", "json", ...Object.keys(FIXTURE)]),
    );
    return out.diagnostics
      .map((d) => `${d.filename}:${String(d.labels[0]?.span.line)} ${d.severity} ${d.code}`)
      .sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function severities(entry: string): Record<string, string | undefined> {
  const dir = repoExtending(entry, SHIPPED);
  try {
    const config: { rules: Record<string, string> } = JSON.parse(
      oxlint(dir, ["-c", ".oxlintrc.json", "--print-config"]),
    );
    return Object.fromEntries(
      Object.keys(REACT_HOOKS_RECOMMENDED).map((r) => [r, config.rules[r]]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Lines in one list and not the other, each marked with which side it is missing from. */
function differences(expected: string[], actual: string[]): string[] {
  return [
    ...expected.filter((line) => !actual.includes(line)).map((line) => `missing    ${line}`),
    ...actual.filter((line) => !expected.includes(line)).map((line) => `unexpected ${line}`),
  ];
}

const problems: string[] = [];
const report = (label: string, lines: string[]) => {
  for (const line of lines) problems.push(`${label}: ${line}`);
};

report("base.json", differences([...BASE_DIAGNOSTICS].sort(), diagnose("base.json")));
report(
  "react.json",
  differences([...BASE_DIAGNOSTICS, ...REACT_DIAGNOSTICS].sort(), diagnose("react.json")),
);

const wanted = Object.entries(REACT_HOOKS_RECOMMENDED);
const have = severities("react.json");
for (const [rule, severity] of wanted)
  if (have[rule] !== severity)
    problems.push(`react.json: ${rule} is ${String(have[rule])}, expected ${String(severity)}`);

// The positive control: each preset with its rules deleted must be seen as different.
const noRules = { extends: ["./base.json"] };
const emptyBase = diagnose("base.json", { "base.json": "{}" });
if (differences(BASE_DIAGNOSTICS.toSorted(), emptyBase).length === 0)
  problems.push("control: an empty base.json produced the expected diagnostics.");
const emptyReact = diagnose("react.json", {
  "base.json": SHIPPED["base.json"] ?? "",
  "react.json": JSON.stringify(noRules),
});
if (differences([...BASE_DIAGNOSTICS, ...REACT_DIAGNOSTICS].sort(), emptyReact).length === 0)
  problems.push("control: a react.json with no rules produced the expected diagnostics.");

if (problems.length > 0) {
  console.error(`✗ oxlint presets: ${String(problems.length)} problem(s)\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `✓ oxlint presets: ${String(BASE_DIAGNOSTICS.length)} base and ${String(REACT_DIAGNOSTICS.length)} react diagnostics, ${String(wanted.length)} rule severities, 2 controls.`,
);
