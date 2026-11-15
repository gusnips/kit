# @gusnips/oxlint

Two oxlint configs: `base.json` for a TypeScript repo and `react.json` for a React one. They hold
the lint core our repos each wrote for ESLint, so a repo keeps only its own rules. A plugin with two
more rules is there when you ask for it (see "Two rules of our own").

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
`eslint-plugin-react-hooks` 7.1.1 sets in `recommended`, at the same level:

- `rules-of-hooks` (error) and `exhaustive-deps` (warning).
- The React Compiler rules: `static-components`, `use-memo`, `preserve-manual-memoization`,
  `immutability`, `globals`, `refs`, `set-state-in-effect`, `error-boundaries` and
  `set-state-in-render` (errors), and `incompatible-library` and `unsupported-syntax` (warnings).
- `purity`, `config` and `gating` (errors) run through the original hooks library, pinned to
  7.1.1, as `react-hooks-js/*`. Oxlint's native versions are missing or behave differently.

The React preset loads this JS plugin for you, including when your config extends it from a nested
workspace. The library is a dependency of this package, not something each app needs to add.
Oxlint calls JS plugin support alpha.

Installing may also pull in ESLint because the hooks library lists it as a peer dependency. The
rules run in oxlint, not the ESLint CLI, and do not use typescript-eslint. They also work when that
unused peer is omitted.

Not there:

- `component-hook-factories`. The library removed this check in 7.1.0. Its old name in 7.1.1 does
  nothing and is not in `recommended`, so this preset does not enable it.
- `no-octal`. oxlint has no such rule, and TypeScript rejects octal literals.
- Native `react/purity` stays off. It reports `new Date()` in a component, and the original plugin
  does not. `react-hooks-js/purity` allows `new Date()` and rejects `Date.now()` and `Math.random()`.
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

## Two rules of our own

oxlint has no `no-restricted-syntax`, and our repos used it for two selectors. The plugin holds
them as real rules. They are off until you turn them on, and oxlint still calls JS plugins alpha.

- `gusnips/no-as-unknown-as` reports `value as unknown as T`. `value as unknown` and
  `value as const` are fine.
- `gusnips/effect-body-must-be-block` reports `useEffect(() => save(), [])`. A short arrow body
  returns its value, and React runs that value as the cleanup. Write `useEffect(() => { save(); }, [])`.
  `useLayoutEffect` and `useInsertionEffect` count too. An arrow that returns a function on purpose,
  like `() => () => stop()`, is fine. `React.useEffect(...)` is not looked at, only the bare name.

```json
{
  "extends": ["./node_modules/@gusnips/oxlint/react.json"],
  "jsPlugins": ["@gusnips/oxlint/plugin"],
  "rules": {
    "gusnips/no-as-unknown-as": "error",
    "gusnips/effect-body-must-be-block": "error"
  },
  "overrides": [{ "files": ["**/*.test.ts"], "rules": { "gusnips/no-as-unknown-as": "off" } }]
}
```

In a workspace repo, oxlint looks for `@gusnips/oxlint/plugin` from the folder of the config file,
not from the folder you run it in. So `oxlint -c ../../.oxlintrc.json` works from `apps/web` when
`@gusnips/oxlint` is installed at the repo root, next to that config. If it is only in
`apps/web/node_modules`, oxlint stops with "Failed to load JS plugin". Add the package to the root
`package.json`.

## Good to know

- `ignorePatterns` does not come through `extends`. oxlint skips what `.gitignore` lists, which
  covers `dist` and `.turbo`. Anything else goes in your own file.
- `plugins` add up. A repo that sets none also gets oxlint's `unicorn` and `oxc` plugins, which the
  ESLint core did not have. Write `"plugins": []` to keep only the ones the preset names.
- Rules that need types, like `no-floating-promises`, stay off until you run `oxlint --type-aware`.
- It needs oxlint 1.93 or newer.
