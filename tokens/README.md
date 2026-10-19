# @gusnips/tokens

The colour names a Tailwind 4 app uses, and the dark-mode switch behind them. You bring the
colours.

```bash
bun add @gusnips/tokens
```

```css
@import "tailwindcss";
@import "@gusnips/tokens/index.css";
```

Two lines, and you can write `bg-card text-card-foreground` anywhere. It renders in light mode
and in dark mode, and no component ever writes a `dark:` variant.

## The mechanism

Twenty names: `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`,
`accent`, `destructive`, their `-foreground` pairs, plus `border`, `input`, `ring` and `scrim`.

Dark mode rebinds **the same names** under a `.dark` class. `bg-card` is one utility that
resolves to a different colour below a `.dark` ancestor. That is the whole trick.

## Your colours

The values that ship are a plain grey scale: readable, and deliberately characterless, so the
app looks like nothing until you decide what it looks like. Override after the import, and set
both halves:

```css
@theme {
  --color-primary: #7c3aed;
}
.dark {
  --color-primary: #a78bfa;
}
```

Skip the second line and your daytime purple stays on screen at night.

## Two names you cannot pick freely

The compile check in this repo measures the placeholders below, so a bad default fails our
build instead of reaching someone. Your overrides need the same measurement, or a bad value
reaches someone through your files instead: run the contrast gate from `@gusnips/vite` (one
script in CI) and it fails your build on both rules below, plus every colour outside your
theme.

- **`--color-input` needs 3:1 against `--color-background`.** It is a field border, and WCAG
  1.4.11 asks 3:1 of anything that outlines a control. This is the one people miss: a grey
  picked to sit nicely next to `--color-border` will not clear it. One codebase this came from
  pointed `input` at its divider grey, 1.6:1, so every text field in two apps had a border
  some people cannot see.
- **`--color-primary` needs its own dark value.** Holding one brand colour across both modes is
  the trap. A fill chosen against a white page is dark, and on a near-black card it lands _on_
  the 3:1 line instead of clear of it. Lift it for dark, and flip `--color-primary-foreground`
  with it, which is why nothing in this family writes `text-white`.

## What is not here

Fonts, shadows, radii, type scale, motion. Radii and type sizes already have Tailwind's own
`--radius-*` and `--text-*` names, so retune those in your `@theme` and every `rounded-lg` in
every component follows. The rest is what your product looks like, and it stays in your product.

One trap worth knowing before you write your own `@theme`: **`--duration-*` is not a Tailwind
namespace.** `--duration-standard: 250ms` compiles to no utility at all, so `duration-standard`
in a `className` is dead text and the transition quietly runs at Tailwind's default. `--ease-*`
beside it _does_ work, which is what hides it: the easing lands, the duration does not. Write
`duration-250`, or keep the token and put `transition-duration: var(--duration-standard)` in a
real rule. One codebase had 61 of these.

## The base rules

`index.css` also brings a handful of rules that every app needs and nobody remembers:

- one `:focus-visible` outline, drawn with `--color-ring`, so it follows your theme into dark
- the same outline in Windows High Contrast, in the reader's own text colour. That mode draws no
  shadows, so a `ring-*` focus ring vanishes there, and nothing in your app can turn this one off
- `cursor: pointer` on buttons, which browsers do not give you
- `color-scheme`, which stops a two-tone seam where a phone toolbar retracts
- reduced motion clamped to `0.01ms` rather than `none`, so animations still land on their end
  pose instead of never appearing, including the two delay properties, which are the half
  people forget
- a thin scrollbar whose thumb reads `--color-input`, and `.scrollbar-none` for a tab strip

To hide the outline on a control that shows focus some other way, put
`focus-visible:outline-hidden` on it. Not `outline-none`: in Tailwind 4, only `outline-hidden`
comes back in High Contrast.

Want them separately? `@gusnips/tokens/theme.css` is the names with no rules,
`@gusnips/tokens/base.css` the rules with no names.

## The busy ring, if you want it

```css
@import "@gusnips/tokens/busy-ring.css";
```

The ring that `<BusyRing />` from `@gusnips/react` draws round a button while it works. It is
not in `index.css`, which leaves motion to your product, so you ask for it. It paints in
`currentColor`, so it needs no colour of its own. Tune it after the import:

```css
:root {
  --busy-ring-width: 3px; /* 2px */
  --busy-ring-duration: 700ms; /* 900ms */
  --busy-ring-duration-reduced: 2000ms; /* 2400ms */
}
```

Under reduced motion it turns slower and keeps turning. The `0.01ms` clamp above would freeze
it, so the ring says `!important` and beats the clamp by being more specific than `*`. A frozen
ring reads as a hang, and the ring is the only sign that a press was heard.

MIT · part of [kit](https://github.com/gusnips/kit)
