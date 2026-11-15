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
 * The check pins:
 *
 * - the fixture's exact diagnostics, per preset. `base.json` must flag the `any`, the unused
 *   variable and the seventeen rules ESLint's `recommended` sets turn on that oxlint leaves
 *   outside its `correctness` category (typescript-eslint's `eslint-recommended` layer adds
 *   four of them: `no-var`, `prefer-const`, `prefer-rest-params`, `prefer-spread`); must NOT flag an unused `_`-prefixed argument or variable;
 *   and must say nothing about React. `react.json` adds the conditional hook, the stale effect
 *   dependency and an `eval` call in a component.
 * - native React rule levels, read back from `--print-config`. It omits JS rules, so their
 *   levels are read from the preset and their implementations are checked through findings.
 * - the hooks library's purity, config and gating rules, loaded from the extended preset's
 *   dependencies at the root and in a nested workspace. A consumer's own plugin must coexist.
 *   `new Date()` stays allowed; `Date.now()` and `Math.random()` must report errors.
 * - the positive control: the same fixture through a copy of each preset with its rules deleted
 *   must NOT match. A check that passes on an empty preset is not looking at the preset.
 * - the plugin (`plugin.js`): its two rules flag exactly what the ESLint selectors they replace
 *   flagged, load from an installed package whether oxlint runs at the repo root or in a nested
 *   workspace, stay off in the presets, and can be turned off for some files. The same fixture ran
 *   through ESLint's own `no-restricted-syntax` once, by hand, when the rules were written.
 *
 * Run: bun run scripts/check-preset.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE = join(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
// `bin/oxlint` is a node script, and the package's exports map does not list it, so find the
// package by its entry and walk back to the bin.
const OXLINT = join(dirname(require.resolve("oxlint")), "..", "bin", "oxlint");
const REACT_HOOKS = dirname(require.resolve("eslint-plugin-react-hooks/package.json"));

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
  "compiler.tsx": `export function Dynamic() {
  const value = eval("1 + 1");
  return <p>{value}</p>;
}
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
  "compiler.tsx:2 error eslint(no-eval)",
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
  "compiler.tsx:2 warning react(unsupported-syntax)",
  "hooks.tsx:6 error react-hooks(rules-of-hooks)",
  "hooks.tsx:14 warning react-hooks(exhaustive-deps)",
];

/** Native equivalents of hooks 7.1.1's recommended rules, with its non-equivalent purity off. */
const NATIVE_REACT_LEVELS: Record<string, string> = {
  "react/rules-of-hooks": "deny",
  "react/exhaustive-deps": "warn",
  "react/static-components": "deny",
  "react/use-memo": "deny",
  "react/preserve-manual-memoization": "deny",
  "react/incompatible-library": "warn",
  "react/unsupported-syntax": "warn",
  "react/immutability": "deny",
  "react/globals": "deny",
  "react/refs": "deny",
  "react/set-state-in-effect": "deny",
  "react/error-boundaries": "deny",
  "react/set-state-in-render": "deny",
  "react/purity": "allow",
};

const COMPILER_FIXTURE = {
  "purity.tsx": `export function Year() {
  const year = new Date().getFullYear();
  return <p>{year}</p>;
}
export function Clock() {
  return <p>{Date.now()}</p>;
}
export function Random() {
  return <p>{Math.random()}</p>;
}
`,
  "config.tsx": `import { read } from "data";
export function External() {
  return <p>{read()}</p>;
}
`,
  "gating.tsx": `export function Gated() {
  "use memo if(bad-flag)";
  return <p>Hello</p>;
}
`,
} satisfies Record<string, string>;

const COMPILER_DIAGNOSTICS = [
  "config.tsx:3 error react-hooks-js(config)",
  "gating.tsx:2 error react-hooks-js(gating)",
  "purity.tsx:6 error react-hooks-js(purity)",
  "purity.tsx:9 error react-hooks-js(purity)",
];

/** Where the plugin's fixture lives: a workspace folder, like the apps that use the plugin. */
const WORKSPACE = "apps/web";

const PLUGIN_FIXTURE: Record<string, string> = {
  // Reported on the inner `x as unknown`, so the line is where `x` starts.
  "cast.ts": `export const flagged = (value: string) => value as unknown as number;
export const alone = (value: string) => value as unknown;
export const constant = ["a"] as const;
export const parenthesized = (value: string) => (value as unknown) as number;
export const twice = (value: string) => value as unknown as unknown;
export const through = (value: string) => value as string as number;
export const nextLine = (value: string) =>
  value as unknown as number;
`,
  // Tests may cast through unknown: the override in the config turns the rule off for them.
  "cast.test.ts": `export const inTest = (value: string) => value as unknown as number;
`,
  "effects.ts": `import * as React from "react";
import { useEffect, useInsertionEffect, useLayoutEffect } from "react";

declare function cleanup(): void;

export function Panel() {
  useEffect(() => cleanup(), []);
  useLayoutEffect(() => cleanup(), []);
  useInsertionEffect(() => cleanup(), []);
  useEffect(() => {
    cleanup();
  }, []);
  useEffect(() => () => cleanup(), []);
  useEffect(function () {
    cleanup();
  }, []);
  useEffect(() => function () {}, []);
  useEffect(cleanup, []);
  React.useEffect(() => cleanup(), []);
  return null;
}
`,
};

const PLUGIN_DIAGNOSTICS = [
  "cast.ts:1 error gusnips(no-as-unknown-as)",
  "cast.ts:4 error gusnips(no-as-unknown-as)",
  "cast.ts:5 error gusnips(no-as-unknown-as)",
  "cast.ts:8 error gusnips(no-as-unknown-as)",
  "effects.ts:7 error gusnips(effect-body-must-be-block)",
  "effects.ts:8 error gusnips(effect-body-must-be-block)",
  "effects.ts:9 error gusnips(effect-body-must-be-block)",
];

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
  ["base.json", "react.json", "react-hooks.js", "plugin.js", "package.json"].map((name) => [
    name,
    readFileSync(join(PACKAGE, name), "utf8"),
  ]),
);

/**
 * A throwaway repo laid out the way an adopter's is: the package files in
 * `node_modules/@gusnips/oxlint`, a `.oxlintrc.json` with `config` in it, and `fixture` at `where`.
 */
function repoWith(
  config: object,
  presets: Record<string, string>,
  fixture: Record<string, string>,
  where = ".",
): string {
  const dir = mkdtempSync(join(tmpdir(), "oxlint-preset-"));
  const installed = join(dir, "node_modules", "@gusnips", "oxlint");
  mkdirSync(installed, { recursive: true });
  for (const [name, source] of Object.entries(presets))
    writeFileSync(join(installed, name), source);
  // Like an isolated install: the hooks library is only reachable from the preset package, not
  // from the consumer root. The inherited jsPlugins entry must resolve from react.json's folder.
  mkdirSync(join(installed, "node_modules"), { recursive: true });
  symlinkSync(REACT_HOOKS, join(installed, "node_modules", "eslint-plugin-react-hooks"), "dir");
  writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify(config));
  mkdirSync(join(dir, where), { recursive: true });
  for (const [name, source] of Object.entries(fixture)) {
    mkdirSync(dirname(join(dir, where, name)), { recursive: true });
    writeFileSync(join(dir, where, name), source);
  }
  return dir;
}

/** The repo whose whole `.oxlintrc.json` is `extends` one preset file. */
function repoExtending(entry: string, presets: Record<string, string>): string {
  return repoWith({ extends: [`./node_modules/@gusnips/oxlint/${entry}`] }, presets, FIXTURE);
}

/** Runs oxlint in `cwd` over `files` and lists each finding as `file:line severity code`. */
function findings(cwd: string, config: string, files: string[]): string[] {
  const out: Output = JSON.parse(oxlint(cwd, ["-c", config, "-f", "json", ...files]));
  return out.diagnostics
    .map((d) => `${d.filename}:${String(d.labels[0]?.span.line)} ${d.severity} ${d.code}`)
    .sort();
}

function diagnose(entry: string, presets: Record<string, string> = SHIPPED): string[] {
  const dir = repoExtending(entry, presets);
  try {
    // The fixture files by name: a bare `.` also walks the preset copy in node_modules.
    return findings(dir, ".oxlintrc.json", Object.keys(FIXTURE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A fixture, linted from the repo root and again from inside the workspace the way a
 * workspace's own `lint` script runs (`oxlint -c ../../.oxlintrc.json src`). Both must give the
 * same findings, with file paths relative to src.
 */
function diagnoseWorkspace(
  config: object,
  presets: Record<string, string> = SHIPPED,
  fixture: Record<string, string> = PLUGIN_FIXTURE,
): [fromRoot: string[], fromWorkspace: string[]] {
  const dir = repoWith(config, presets, fixture, join(WORKSPACE, "src"));
  try {
    const files = Object.keys(fixture).map((name) => join(WORKSPACE, "src", name));
    const fromRoot = findings(dir, ".oxlintrc.json", files).map((line) =>
      line.replace(`${WORKSPACE}/src/`, ""),
    );
    const fromWorkspace = findings(join(dir, WORKSPACE), "../../.oxlintrc.json", ["src"]).map(
      (line) => line.replace("src/", ""),
    );
    return [fromRoot, fromWorkspace];
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
    return Object.fromEntries(Object.keys(NATIVE_REACT_LEVELS).map((r) => [r, config.rules[r]]));
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

const wanted = Object.entries(NATIVE_REACT_LEVELS);
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

// The plugin. A repo opts in with `jsPlugins` and the two rules, and turns them off for tests.
const asked = {
  extends: ["./node_modules/@gusnips/oxlint/react.json"],
  jsPlugins: ["@gusnips/oxlint/plugin"],
  rules: { "gusnips/no-as-unknown-as": "error", "gusnips/effect-body-must-be-block": "error" },
  overrides: [{ files: ["**/*.test.ts"], rules: { "gusnips/no-as-unknown-as": "off" } }],
};
const pluginWanted = [...PLUGIN_DIAGNOSTICS].sort();
const [pluginFromRoot, pluginFromWorkspace] = diagnoseWorkspace(asked);
report("plugin, at the root", differences(pluginWanted, pluginFromRoot));
report("plugin, in a workspace", differences(pluginWanted, pluginFromWorkspace));
// Opt-in: the presets alone say nothing about either rule.
for (const entry of ["base.json", "react.json"]) {
  const [quiet] = diagnoseWorkspace({ extends: [`./node_modules/@gusnips/oxlint/${entry}`] });
  report(`${entry} on the plugin fixture`, differences([], quiet));
}
// The positive control: a plugin with its rules deleted must not pass, whether oxlint rejects the
// config (a rule it cannot find is an error) or finds nothing.
const hollow = {
  ...SHIPPED,
  "plugin.js": 'export default { meta: { name: "gusnips" }, rules: {} };',
};
let hollowPasses = false;
try {
  hollowPasses = differences(pluginWanted, diagnoseWorkspace(asked, hollow)[0]).length === 0;
} catch {
  // oxlint refused the config: the control holds.
}
if (hollowPasses) problems.push("control: a plugin with no rules produced the expected findings.");

// --print-config omits JS rules in oxlint 1.93, so pin the shared levels from the preset and
// prove the implementation with findings. Config/gating need options to reach their error paths;
// those options belong only to these fixture files, not to the shared preset.
const reactPreset: { rules: Record<string, string> } = JSON.parse(SHIPPED["react.json"] ?? "");
for (const rule of ["purity", "config", "gating"]) {
  const name = `react-hooks-js/${rule}`;
  if (reactPreset.rules[name] !== "error")
    problems.push(`react.json: ${name} is ${String(reactPreset.rules[name])}, expected error`);
}
const compilerConfig = {
  extends: ["./node_modules/@gusnips/oxlint/react.json"],
  // A consumer can add its own plugin without losing the inherited hooks library.
  jsPlugins: ["@gusnips/oxlint/plugin"],
  overrides: [
    {
      files: ["**/config.tsx"],
      rules: {
        "react-hooks-js/config": ["error", { environment: { moduleTypeProvider: true } }],
      },
    },
    {
      files: ["**/gating.tsx"],
      rules: { "react-hooks-js/gating": ["error", { dynamicGating: { source: "feature-flags" } }] },
    },
  ],
};
const [compilerFromRoot, compilerFromWorkspace] = diagnoseWorkspace(
  compilerConfig,
  SHIPPED,
  COMPILER_FIXTURE,
);
report("compiler, at the root", differences(COMPILER_DIAGNOSTICS, compilerFromRoot));
report("compiler, in a workspace", differences(COMPILER_DIAGNOSTICS, compilerFromWorkspace));
const [compilerFromBase] = diagnoseWorkspace(
  { extends: ["./node_modules/@gusnips/oxlint/base.json"] },
  SHIPPED,
  COMPILER_FIXTURE,
);
report("base.json on the compiler fixture", differences([], compilerFromBase));

// Base-scoped adapters can load the same library without adopting the whole React preset.
// A React-shaped component outside client/ must stay quiet even though its calls are impure.
const scopedCompilerFixture = Object.fromEntries(
  Object.entries(COMPILER_FIXTURE).map(([name, source]) => [`client/${name}`, source]),
);
scopedCompilerFixture["server/outside.tsx"] = `export function Outside() {
  return <p>{Date.now() + Math.random()}</p>;
}
`;
const scopedCompilerConfig = {
  extends: ["./node_modules/@gusnips/oxlint/base.json"],
  jsPlugins: [
    { name: "react-hooks-js", specifier: "@gusnips/oxlint/react-hooks" },
    "@gusnips/oxlint/plugin",
  ],
  overrides: [
    {
      files: ["**/client/**"],
      rules: {
        "react-hooks-js/purity": "error",
        "react-hooks-js/config": "error",
        "react-hooks-js/gating": "error",
      },
    },
    ...compilerConfig.overrides,
  ],
};
const [scopedFromRoot, scopedFromWorkspace] = diagnoseWorkspace(
  scopedCompilerConfig,
  SHIPPED,
  scopedCompilerFixture,
);
const scopedWanted = COMPILER_DIAGNOSTICS.map((line) => `client/${line}`);
report("scoped compiler, at the root", differences(scopedWanted, scopedFromRoot));
report("scoped compiler, in a workspace", differences(scopedWanted, scopedFromWorkspace));

// Kit's original hooks scope was react/, including the root command. Copy the actual root and
// nested configs into a throwaway repo so this check also catches an accidental native/ opt-in.
const kitRootConfig: {
  overrides?: { files?: string[]; rules?: Record<string, string> }[];
} = JSON.parse(readFileSync(join(PACKAGE, "..", ".oxlintrc.json"), "utf8"));
const kitNativeConfig: { rules?: Record<string, string> } = JSON.parse(
  readFileSync(join(PACKAGE, "..", "native", ".oxlintrc.json"), "utf8"),
);
const rootReactRules = kitRootConfig.overrides?.find((entry) =>
  entry.files?.includes("react/**/*.{ts,tsx}"),
)?.rules;
for (const rule of ["purity", "config", "gating"]) {
  const name = `react-hooks-js/${rule}`;
  if (rootReactRules?.[name] !== "error" || kitNativeConfig.rules?.[name] !== "off")
    problems.push(`kit: ${name} must be error only in react/ and off in native/`);
}
const kit = repoWith(kitRootConfig, SHIPPED, {
  "react/purity.tsx": COMPILER_FIXTURE["purity.tsx"],
  "native/purity.tsx": COMPILER_FIXTURE["purity.tsx"],
  "http/purity.tsx": COMPILER_FIXTURE["purity.tsx"],
});
try {
  symlinkSync(join(kit, "node_modules", "@gusnips", "oxlint"), join(kit, "oxlint"), "dir");
  for (const workspace of ["react", "native"])
    writeFileSync(
      join(kit, workspace, ".oxlintrc.json"),
      readFileSync(join(PACKAGE, "..", workspace, ".oxlintrc.json"), "utf8"),
    );
  const purityWanted = COMPILER_DIAGNOSTICS.filter((line) => line.includes("purity.tsx:"));
  const rootWanted = purityWanted.map((line) => `react/${line}`);
  report(
    "kit root command",
    differences(rootWanted, findings(kit, ".oxlintrc.json", ["react", "native", "http"])),
  );
  report(
    "kit root config alone",
    differences(
      rootWanted,
      findings(kit, ".oxlintrc.json", ["--disable-nested-config", "react", "native", "http"]),
    ),
  );
  report(
    "kit nested react",
    differences(purityWanted, findings(join(kit, "react"), ".oxlintrc.json", ["purity.tsx"])),
  );
  report(
    "kit nested native",
    differences([], findings(join(kit, "native"), ".oxlintrc.json", ["purity.tsx"])),
  );
} finally {
  rmSync(kit, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`✗ oxlint presets: ${String(problems.length)} problem(s)\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `✓ oxlint presets: ${String(BASE_DIAGNOSTICS.length)} base and ${String(REACT_DIAGNOSTICS.length)} react diagnostics, ${String(wanted.length)} native and 3 JS rule severities, 3 controls, ${String(PLUGIN_DIAGNOSTICS.length)} opt-in and ${String(COMPILER_DIAGNOSTICS.length)} compiler findings at the root and in a workspace.`,
);
