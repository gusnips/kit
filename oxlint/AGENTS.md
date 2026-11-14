Rules for `@gusnips/oxlint`. The repo-wide rules are in the root `AGENTS.md`.

# What the presets are, measured

Two JSON files and no code. They are the lint core every app repeated in its ESLint config
(`js` and `typescript-eslint` `recommended`, `no-explicit-any`, `no-unused-vars` with `^_`,
`no-undef` off, `eslint-plugin-react-hooks` 7), written once for oxlint. Anything a repo wrote for
itself (`no-restricted-imports`, `no-restricted-syntax`, `no-console`, type-aware rules) stays out.
A rule goes in only when most repos had it.

Read on oxlint 1.93.0, 2026-11-13:

- `extends` carries `rules`, `categories` and `plugins`. It does NOT carry `ignorePatterns`: a
  pattern in an extended file never matched, even `**/dist/**`. oxlint does skip what `.gitignore`
  lists, so build output is already out. Do not put `ignorePatterns` in a preset.
- `plugins` are a union of the extended file's, the repo's own and, only when the repo sets none,
  oxlint's defaults (`unicorn`, `typescript`, `oxc`). A preset cannot switch a default plugin off.
  `"plugins": []` in the repo keeps just the preset's.
- `react/rules-of-hooks` is in oxlint's `pedantic` category, not `correctness`, so `categories`
  alone does not turn it on. The same holds for 13 rules ESLint's two `recommended` sets enable, which
  `base.json` names one by one. `bun run test` fails if a line goes missing.
- `oxlint --rules` prints nothing without `-f json`.
- A fixture can stay silent for the wrong reason. A rule oxlint does not know is not an error, so
  `scripts/check-preset.ts` runs the installed oxlint over a fixture, compares every diagnostic,
  reads the React rule levels back with `--print-config`, and runs the same fixture through a preset
  with its rules deleted, which must NOT match.

# Where oxlint and the ESLint plugin differ

Measured 2026-11-13 by running `react.json` over the 22 checkouts that had an `apps`, `packages` or
`src` folder (some lag `origin/main`; a reading, not a count to quote).

- `react/purity` flags `new Date()`. `react-hooks/purity` flags `Date.now()` and `Math.random()` and
  not `new Date()`, which is how a footer gets its year. 82 of 101 purity reports, in 15 repos, were
  `new Date()`. Off until oxc matches the plugin.
- `react/jsx-key` flags an array of elements passed as a prop. The `Trans` `components` prop takes
  exactly that. 256 reports in 7 repos. Off.
- Left on although ESLint never had them: `react/no-children-prop` (3 reports in 3 repos, all in tests
  that pass `children` to `createElement`) and the other `correctness` rules of the `react` plugin.
  They fire rarely and are right when they do.
- `unsupported-syntax`, `config` and `gating` from the plugin do not exist in oxlint.

# Changing a preset

Run `bun run test` in this folder. After an oxlint bump, list its rules with
`oxlint --rules -f json` and look for a rule that moved into `correctness` (it would then fire in
every repo) or changed name. Raise the `oxlint` peer range only after the check passes on the new
version.
