Rules for anything under `react/src/ui/`. The frontend's other rules, invariants 1 to 15 among
them, are in the root `AGENTS.md`.

# Six more invariants, for anything under `react/src/ui/`

The audit's headline finding was a NEGATIVE one: no wrapper in either donor adds scroll lock,
focus trap, ESC, outside-dismiss, focus return, roving focus or typeahead. Base UI does all of
it, and a wrapper that "adds" them is adding a second implementation of something that already
works. Twenty of the donor's twenty-seven wrappers were dropped on that basis.

What a wrapper legitimately buys is composition a caller cannot skip, required-a11y props
expressed as types, and the facts below — each of which cost somebody a debugging session:

16. **z-index goes on the Viewport, not the Popup.** `position: fixed` creates a stacking
    context, so a z-index on the Popup competes only INSIDE the Viewport's own `z-auto` context
    and paints under every `z-30` element on the page.
17. **A drawer TIES with dialog rather than beating it.** Ranked above, a drawer paints over
    every modal opened from inside it — the user taps, and nothing appears. At a tie the dialog
    wins on DOM order, because it portals second.
18. **Every part goes inside a Portal, including the ones that do not look like they need it.**
    Base UI throws error #26 otherwise, and a non-overlay "scoped" variant still portals — into
    a container rather than the body. Related: a combobox inside a portalled dialog is that
    dialog's SIBLING on `<body>`, so without a higher z it paints behind its own anchor.
19. **`outline-none` belongs on a popup container and nowhere else.** A popup takes focus
    programmatically, so it is the one element that legitimately suppresses the ring; anywhere
    else it deletes the app's only keyboard-focus affordance. Worth enforcing structurally — one
    donor budgets one reset per `<Primitive.Popup>` in a file, which cannot rot the way a
    filename allowlist does.

    **An item is not a container, even though its highlight shows focus.** Forced colors paint no
    background, so the highlight is gone there, and a bare `outline-none` leaves the item with
    nothing. The select's and the combobox's items both carried one, and `focus.test.ts` allowed
    it, until a fleet audit counted 493 lines pairing `outline-none` with a `ring-*` across nine
    products. An item hides the outline with `outline-hidden`, which Tailwind brings back in
    forced colors, and pulls it inward with a negative offset, or the list's overflow clips it.
    The combobox's item never takes focus at all — the input keeps it — so it draws its outline
    off `data-highlighted` under `forced-colors:` instead. Both measured in Chromium with forced
    colors emulated, on the real components.

20. **Style off the accessibility attribute, never a parallel data attribute.** The primitive
    writes `aria-selected` and its own `data-*` from one state; styling the a11y contract is
    what keeps what a screen reader announces and what an eye sees from drifting apart.
21. **A shared control never hardcodes a colour it did not derive from a token.** `text-white`
    on a primary fill is the common one and it is broken by construction: across two donors
    `--color-primary-foreground` in dark mode is `#ffffff` and a near-black, so white-on-primary
    is correct in one and unreadable in the other. Always `text-primary-foreground`,
    `bg-scrim`, `border-border` — and never `bg-black/40`, which one donor wrote as two
    different values for the same job.
