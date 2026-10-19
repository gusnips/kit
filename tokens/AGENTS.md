Rules for `@gusnips/tokens`. The frontend's other rules are in the root `AGENTS.md`.

# The token contract, measured

Across the two donors, **25 token names are spelled identically and the values agree on
exactly four** — all of them the literal `#ffffff`. That is the argument for this split in one
sentence: the names are the contract, the values are the brand, and there is no shared palette
to find. Two of those names carry a floor rather than a preference, and a brand overriding them
needs to know it:

- `--color-input` must clear **3:1 against `--color-background`** (WCAG 1.4.11 — it is a
  control boundary). One donor's was ~1.6:1, so every field border in two of its apps failed.
  Fixing the token did not reach its marketing site: that site passes its own `border-white/15`
  over the field, so it measured 1.5–1.8:1 until someone read the class string.
- `--color-primary` must be **re-tuned in dark mode, not reused**. Holding one brand colour in
  both modes is the trap; the donor that lifts it and flips `--color-primary-foreground` to a
  near-black is the one whose primary control is legible on a card either way.

And one trap that is not about contrast at all:

- **`--duration-*` is not a Tailwind namespace.** Defining `--duration-standard: 250ms` in
  `@theme` compiles no utility, so `duration-standard` in a `className` is dead text and the
  transition silently runs at Tailwind's default. `--ease-*` beside it DOES work, which is
  exactly what hides it — the easing lands and the duration does not. One donor has 61 of
  these. Use `duration-[250ms]`, or keep the token and write
  `transition-duration: var(--duration-standard)` in a real rule. The token package's compile
  check pins this so it cannot be rediscovered a third time.

  It is not the only one. The same donor defines `--weight-regular|medium|semibold|bold`, and
  Tailwind's namespace is `--font-weight-*` — four more dead tokens, harmless only because
  nothing reads them. And `--radius-sm|md|lg|xl` are **already stock Tailwind names**, so both
  donors were retuning built-ins rather than inventing a scale; `rounded-full` is a static
  utility compiling to `calc(infinity * 1px)` and needs no token at all. So the general rule:
  **before defining a token, check the namespace exists** — `@theme` accepts any `--name` you
  write and silently generates nothing for a namespace Tailwind does not have. That is why
  this package ships colours only, and why the compile check asserts the absent ones stay
  absent: if Tailwind ever adds `--duration-*`, the check fails and tells us we can ship them.
