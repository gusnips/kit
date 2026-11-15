Rules for `@gusnips/oxlint`. The repo-wide rules are in the root `AGENTS.md`.

# What the presets are, measured

Two JSON files and one plugin file. The JSON files are the lint core every app repeated in its
ESLint config (`js` and `typescript-eslint` `recommended`, `no-explicit-any`, `no-unused-vars` with
`^_`, `no-undef` off, `eslint-plugin-react-hooks` 7), written once for oxlint. Anything a repo wrote
for itself (`no-restricted-imports`, `no-console`, type-aware rules) stays out. A rule goes in only
when most repos had it. The plugin (`plugin.js`, exported as `@gusnips/oxlint/plugin`) is the one
exception, see below.

Read on oxlint 1.93.0, 2026-11-13:

- `extends` carries `rules`, `categories` and `plugins`. It does NOT carry `ignorePatterns`: a
  pattern in an extended file never matched, even `**/dist/**`. oxlint does skip what `.gitignore`
  lists, so build output is already out. Do not put `ignorePatterns` in a preset.
- `plugins` are a union of the extended file's, the repo's own and, only when the repo sets none,
  oxlint's defaults (`unicorn`, `typescript`, `oxc`). A preset cannot switch a default plugin off.
  `"plugins": []` in the repo keeps just the preset's.
- `react/rules-of-hooks` is in oxlint's `pedantic` category, not `correctness`, so `categories`
  alone does not turn it on. The same holds for 17 rules ESLint's `recommended` sets enable, which
  `base.json` names one by one. `bun run test` fails if a line goes missing.
- `oxlint --rules` prints nothing without `-f json`.
- A fixture can stay silent for the wrong reason. A rule oxlint does not know is not an error, so
  `scripts/check-preset.ts` runs the installed oxlint over a fixture, compares every diagnostic,
  reads the React rule levels back with `--print-config`, and runs the same fixture through a preset
  with its rules deleted, which must NOT match.

# Hooks rules from the original library

Since 0.2.2, `react.json` uses exact `eslint-plugin-react-hooks` 7.1.1 for `purity`, `config` and
`gating`, as errors under `react-hooks-js`. The native purity rule stays off: it reports `new Date()`
where the original accepts it. Use the library, not a local copy of these checks.

Measured on oxlint 1.93.0, 2026-11-15:

- The library's 7.1.1 `recommended` and `recommended-latest` configs enable those three as errors.
  `component-hook-factories` was removed in 7.1.0. In 7.1.1 it is a deprecated rule whose `create`
  returns `{}`, and neither recommended config enables it. Do not enable or claim that check.
- `jsPlugins` in an extended config resolves relative to that extended file. A dependency only in
  `@gusnips/oxlint/node_modules` works at the consumer root and from `apps/web` with
  `-c ../../.oxlintrc.json`. The consumer needs no direct hooks-library dependency or JS plugin
  entry. Its own `@gusnips/oxlint/plugin` entry can coexist with the inherited library.
- The library declares ESLint as a required peer. Bun's default install resolves that peer, but
  the library runs inside oxlint without importing it. A fresh `bun install --omit=peer` with no
  resolvable `eslint` still reports `Date.now()` and `Math.random()` and accepts `new Date()`.
  No ESLint CLI or typescript-eslint runs here. Do not claim that the dependency tree has no ESLint.
- `--print-config` omits JS plugins and their rules. The check reads their three levels from
  `react.json` and proves their implementations with findings. Config/gating controls apply compiler
  options only to fixture files, then report an invalid provider and gating directive. Those
  options never go in the shared preset.
- Only `react.json` loads the library. `base.json` stays unchanged, so consumers preserving older
  hooks rules through the base preset keep their existing policy.

# The plugin: the two `no-restricted-syntax` selectors

oxlint 1.93.0 has no `no-restricted-syntax`. 8 repos wrote the same two selectors with it (read from
their ESLint configs on 2026-11-14), so `plugin.js` holds them as rules, plugin name `gusnips`:

- `no-as-unknown-as`: `TSAsExpression > TSAsExpression.expression[typeAnnotation.type="TSUnknownKeyword"]`.
  Reported on the inner `x as unknown`.
- `effect-body-must-be-block`:
  `CallExpression[callee.name=/^use(Layout|Insertion)?Effect$/] > ArrowFunctionExpression[body.type!="BlockStatement"][body.type!="ArrowFunctionExpression"][body.type!="FunctionExpression"]`.
  Reported on the arrow. `React.useEffect(...)` is not matched, because the selector reads
  `callee.name` and a member expression has none. Keep it that way: a rule that is wider than the
  selector would report lines the repos never saw.

The presets do not enable them. A repo opts in with `jsPlugins` and `rules`, and turns
`no-as-unknown-as` off for tests with an `overrides` entry (measured: a plugin rule goes off in
`overrides` like any other).

Read on oxlint 1.93.0, 2026-11-14:

- A `jsPlugins` entry that is a package name resolves from the folder of the config file that lists
  it, not from the working directory. It works from a nested workspace (`oxlint -c ../../.oxlintrc.json`
  run in `apps/web`) when the package is in the `node_modules` next to the config. With the config at
  the root and the package only in `apps/web/node_modules`, oxlint fails with "Failed to load JS
  plugin ... Cannot find module". A config placed next to the workspace works too.
- An ESLint-style `create(context)` with `context.report({ node, messageId })` works as is.
- Same lines and columns as ESLint's `no-restricted-syntax` over the same fixture: 7 findings, ESLint
  9.39.5 with typescript-eslint 8.72.2 on TypeScript 5.9.3 against oxlint 1.93.0. The fixture is in
  `scripts/check-preset.ts`. Kit does not run ESLint, so that comparison ran once in a scratch
  install. Repeat it when a rule changes: copy the fixture files out, run ESLint with the two selectors
  as `no-restricted-syntax` options, and compare `file:line:column`.
- A fixture line that starts with `as` is a parse error: TypeScript does not read `as` as an operator
  after a line break, so the whole file is skipped and the findings go missing without a failure.
  `scripts/check-preset.ts` lists exact findings, so it would catch that.

`bun run test` checks the plugin the same way as the presets: exact findings from the repo root and
from inside a workspace, the presets alone report nothing, and a plugin with its rules deleted must
NOT match.

# Where oxlint and the ESLint plugin differ

Measured 2026-11-13 by running `react.json` over the 22 checkouts that had an `apps`, `packages` or
`src` folder (some lag `origin/main`; a reading, not a count to quote).

- `react/purity` flags `new Date()`. `react-hooks/purity` flags `Date.now()` and `Math.random()` and
  not `new Date()`, which is how a footer gets its year. 82 of 101 purity reports, in 15 repos, were
  `new Date()`. The native rule stays off; the original check now runs as `react-hooks-js/purity`.
- `react/jsx-key` flags an array of elements passed as a prop. The `Trans` `components` prop takes
  exactly that. 256 reports in 7 repos. Off.
- Left on although ESLint never had them: `react/no-children-prop` (3 reports in 3 repos, all in tests
  that pass `children` to `createElement`) and the other `correctness` rules of the `react` plugin.
  They fire rarely and are right when they do.
- `config` and `gating` have no native oxlint equivalents; the hooks JS plugin now supplies them.
  `no-octal` has no oxlint rule.
- Correction, measured 2026-11-15: oxlint 1.93.0 does have `react/unsupported-syntax`. Versions
  0.1.0 through 0.2.0 left it out and wrongly listed it as unavailable. Version 0.2.1 restores it as
  a warning, matching both `recommended` and `recommended-latest` in eslint-plugin-react-hooks
  7.1.1. The check pins its severity and an `eval` call in a component. `base.json` is unchanged:
  a repo keeping older hooks rules can extend it and enable only the rules it already had.

# Changing a preset

Run `bun run test` in this folder. After an oxlint bump, list its rules with
`oxlint --rules -f json` and look for a rule that moved into `correctness` (it would then fire in
every repo) or changed name. Raise the `oxlint` peer range only after the check passes on the new
version.

**Take the ESLint side from `eslint --print-config <a .ts file>`, never from reading the
`recommended` arrays.** 0.1.0 shipped without `no-var`, `prefer-const`, `prefer-rest-params` and
`prefer-spread`: typescript-eslint's `eslint-recommended` layer turns them on for TypeScript files,
and the same layer turns off the rules TypeScript checks itself, so the two arrays read by hand miss
both. Diff the printed rules against `oxlint --print-config` over the preset. Outside the React
rules, the 2026-11-14 comparison found only `no-octal` missing, which oxlint has no rule for.
