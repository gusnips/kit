# @gusnips/oxlint

Two oxlint configs: `base.json` for a TypeScript repo and `react.json` for a React one. They hold
the lint core our repos each wrote for ESLint, so a repo keeps only its own rules.

```bash
bun add -d @gusnips/oxlint oxlint
```

`.oxlintrc.json`:

```json
{ "extends": ["./node_modules/@gusnips/oxlint/react.json"] }
```

`package.json`:

```json
{ "scripts": { "lint": "oxlint" } }
```

## What is in them

`base.json` turns on oxlint's `typescript` plugin and its `correctness` rules, as errors. On top of
that:

- `no-explicit-any` is an error.
- An unused variable or argument is an error, unless its name starts with `_`.
- `no-undef` is off. TypeScript already reports names that do not exist.
- The rules that ESLint's `recommended` and typescript-eslint's `recommended` switch on, and that
  oxlint keeps outside `correctness`: `ban-ts-comment`, `no-array-constructor`,
  `no-case-declarations`, `no-empty`, `no-empty-object-type`, `no-fallthrough`, `no-namespace`,
  `no-prototype-builtins`, `no-regex-spaces`, `no-require-imports`, `no-unexpected-multiline`,
  `no-unnecessary-type-constraint`, `no-unsafe-function-type`, `no-var`, `prefer-const`,
  `prefer-rest-params` and `prefer-spread`.

`react.json` extends `base.json`, turns on the `react` plugin, and sets what
`eslint-plugin-react-hooks` 7 sets in `recommended`, at the same level:

- `rules-of-hooks` (error) and `exhaustive-deps` (warning).
- The React Compiler rules: `static-components`, `use-memo`, `preserve-manual-memoization`,
  `immutability`, `globals`, `refs`, `set-state-in-effect`, `error-boundaries` and
  `set-state-in-render` (errors), and `incompatible-library` (warning).

Not there:

- `unsupported-syntax`, `config` and `gating`. oxlint does not have them yet.
- `no-octal`. oxlint has no such rule, and TypeScript rejects octal literals.
- `react/purity` is off. It reports `new Date()` in a component, and the ESLint plugin does not. The
  plugin still reports `Date.now()` and `Math.random()`.
- `react/jsx-key` is off. It reports the `components={[<b />, <i />]}` array that react-i18next's
  `Trans` takes.
- `react/react-in-jsx-scope` is off. The JSX transform does not need `React` in scope.
- A refresh rule. Most of our repos turn `only-export-components` off.

Turn any of them on in your own file.

## Your own rules

Write them in your `.oxlintrc.json`, next to `extends`. Yours win.

```json
{
  "extends": ["./node_modules/@gusnips/oxlint/react.json"],
  "rules": { "no-console": "error" },
  "overrides": [{ "files": ["**/*.test.ts"], "rules": { "typescript/no-explicit-any": "off" } }]
}
```

## Good to know

- `ignorePatterns` does not come through `extends`. oxlint skips what `.gitignore` lists, which
  covers `dist` and `.turbo`. Anything else goes in your own file.
- `plugins` add up. A repo that sets none also gets oxlint's `unicorn` and `oxc` plugins, which the
  ESLint core did not have. Write `"plugins": []` to keep only the ones the preset names.
- Rules that need types, like `no-floating-promises`, stay off until you run `oxlint --type-aware`.
- It needs oxlint 1.93 or newer.
