What moving each app onto the frontend packages taught, migration by migration. Read the last
section, "How to migrate a repo", before you start one: it is the check that is not optional.

# What the migrations taught

## Migration 1 (−513 lines, 12 commits)

- **An API this package got wrong shows up as an adapter in the adopter.** `MeQuery`'s first
  state was `"loading"`, so wiring `createRequireProfile` to a react-query hook needed six
  hand-written lines whose entire job was renaming one string. Eight of the twelve repos are on
  react-query and would each have written it, with three states to map and three chances to map
  one wrong. react-query's own word is `"pending"`; with the words matching, a `UseQueryResult`
  satisfies `MeQuery` structurally and the hook goes in directly. **A six-line adapter in the
  first adopter is a design review, not a chore.** Pin the shape with a type-level assertion so
  it cannot drift back.
- **The house's own patterns are part of the contract.** `createErrorDescriber` took
  `t: (key: string) => string`, which no app on this stack can supply: every one declares
  i18next's `CustomTypeOptions.resources`, which types `t` to accept only the keys its catalog
  has — so a typed `t` is not assignable to anything asking for `string`, and the only way
  through is the cast the house rules forbid. The fix was to name the keys each function looks
  up. That is strictly better anyway: the doc comment listing seven required catalog keys became
  a type, so a catalog missing one is a compile error rather than a raw key on screen.
- **The whole point is the third repo.** The audit found `og:image` surviving onto a shell in one
  donor (invariant 12). This adopter — not a donor, not read during the audit — was shipping three
  404 shells advertising `/og/__not-found__.png`, a file its card generator has never rendered
  because it only renders pages in the registry. Every share of a dead link unfurled broken, in
  three languages, and nothing in a browser shows it.
- **A rig written twice in ONE repo is the strongest possible signal.** This adopter had two
  prerender rigs — site and docs — each with its own `escapeAttr`, `setMeta`, `pageFile`,
  `assertRendered`, `loadTemplate`, `loadRenderer` and sitemap writer. `resolve` was
  byte-identical between them, comment included. Both are the package now, and both sitemaps came
  out byte-identical to the previous build, which is the check that says the merge lost nothing.
- **Migrating a file rereads it, which is what finds the dead code.** The site's `index.html`
  carried 43 lines of `FAQPage` JSON-LD that the baker stripped from every page and rebuilt from
  the catalog — dead, and already drifted to four questions where the page renders seven. The
  site's error boundary had `crash.title`, `crash.body` and `crash.reload` written in all three
  locales and rendered none of them, showing a hardcoded English "Reload" instead. The
  dashboard's crash text had `{...rise(0.15)}` followed by `className="…"`, so JSX's later prop
  won and the animation class was silently dropped.
- **A contract can be a lint the adopter never ran.** `@gusnips/tokens` was NOT imported —
  its 808-line theme already defines 19 of the 20 semantic names, and the values are the
  brand, so importing placeholder greys to override them all would have been net-positive in
  lines for nothing. Reading the contract against the theme was still worth the whole exercise:
  `--color-input` measured **1.43:1** in light and **1.58:1** in dark against a 3:1 floor, so
  every field border in the product failed WCAG 1.4.11 in both modes. **Not importing a package
  and still using it is a real outcome.**
- **A silent no-op is worse than a missing feature.** `bakeHead` threw on a `<meta>` it was asked
  to set and could not find, but wrote the canonical with `String.replace` — which succeeds when
  it matches nothing. A template with no canonical would have shipped every page without one,
  quietly. Found because the docs template is exactly that template.

_(The audit that preceded the first line of code already taught these.)_

- **The audit finds bugs in repos that are not the extraction source.** Reading the two donors
  against each other found a sign-out-on-a-Wi-Fi-blip in one, a `RequireStaff` in a third repo
  that was the exact code that donor had already fixed, and an unguarded module-scope
  `localStorage` in the other. None of these had a test. None broke anything visible. All would
  have shipped.
- **A negative result is a finding.** The donor had 27 Base UI wrappers and the hypothesis was
  that they added scroll lock, focus trap, ESC, outside-dismiss and focus return. They add none
  of it — Base UI already does. The scope went from 27 to 5 before anything was written. Not
  extracting something is a valid outcome, and cheaper than extracting it and discovering later.
  Two then came back, and how they came back is the other half of the lesson: **menu** because
  the donor that had one knew a fact no comment can enforce (`GroupLabel` outside its `Group`
  throws — `Base UI error #31`, plus a link to look it up, naming neither the file, the part nor
  the component — so the part is not exported and the caption is a prop), and **tabs** because
  `overflow-x: auto` forces `overflow-y` off `visible`, and a self-scrolling rail therefore
  crops the focus ring on the tab the keyboard is on. Seven, not five. A wrapper earns its place
  by knowing something, never by styling something.
- **The best finding was not a bug in one repo, it was a landmine in another.** One repo
  prerenders with `react-dom/static` and documents why. A second uses `renderToString` and is
  safe _today_ only because its site happens to have no `lazy()` routes. That is not a bug to
  file; it is a trap to remove for everyone, which is what a package can do and a code review
  cannot.
- **When two donors disagree, check before taking the older one.** One repo's missing
  `ssr.noExternal` looked like a bug against another's documented one. Measured: the SSR bundle
  was 2.09 MB with zero bare imports, because Vite does not externalize linked workspace deps.
  The declaration is insurance, not a fix. Say which it is in the commit.
- **Split the envelope from the framing wherever both exist.** One repo's SSE reader is
  spec-correct but welded to `TextDecoderStream`; another's is a platform-free `feed(text)` that
  a React Native app shares — and it silently overwrites repeated `data:` lines. Neither is the
  answer alone. Export the parser beside the client, and expect the same shape elsewhere.

## Migration 2 (−735 lines, 14 commits)

The first repo with three apps and a phone, and the first that is a **donor** rather than only an
adopter. That changes what a migration finds: instead of one app missing a lesson, there are two
siblings in one tree and only one of them ever got the fix.

- **A fleet-wide bug hid in `turbo.json`.** The `build` task hashed one env var, and the four
  `VITE_*` ones — which Vite **inlines into the bundle**, and one of which the prerender reads for
  every canonical, every `og:url` and the whole sitemap — were not in the hash. Staging and
  production pass different values. A build right after a staging build is a cache hit, so
  production ships pointing at `stg.` on every address and talking to the staging API, and nothing
  about it looks wrong. `"env": ["VITE_*"]` as a wildcard, because every variable with that prefix
  goes into the bundle by definition. turbo's framework inference adds `VITE_*` by itself for a
  workspace that depends on vite (seen on 2.10 and 2.11, so this said "2.11 now" wrongly), and the
  line stays anyway: with that inference off and the line gone, a build came out with no API
  address at all, and the next build replayed it from the cache.
  **This said every repo on the stack carried the fix (2026-09-11), and two did not.** A fleet
  drift check on 2026-09-30 found one repo whose `turbo.json` never named `VITE_*`, and one whose
  site and docs entries had dropped it: a `<pkg>#build` entry REPLACES `build` rather than merging
  with it, so an entry written to add `dist-ssr/**` resolved to no env and no `dependsOn`
  (`--dry=json`). Both were covered only by the inference. Measured with the inference off, which
  is the only way the gap shows: the hash did not move with the variable. Repeat the env in every
  `<pkg>#build` entry, and check with `--framework-inference=false`, never with the default.
- **The sibling app is the finding.** Three times over, in one tree: the admin's own
  `isChunkLoadError` matched Chrome's phrasing and not Firefox's, so a stale deploy read as a hard
  crash on Firefox; the admin's `vite:preloadError` handler reloaded the whole page for a CSS
  _hint_ failure and swallowed real ones; and the admin's `themeStore` still read `localStorage`
  unguarded at module scope, the white screen the web app had fixed two days earlier. All three
  were already right in the app next door. Nothing merged them, so nothing found them.
- **The invariant-12 bug the audit read in this repo's code was live.** `404.html` advertised
  `og:image = /og/__not-found__.png`, a file the card generator has never rendered because it only
  renders pages in the registry. Same as the first adopter, found the same way — by reading the
  shell branch rather than the browser. (This bullet used to say "a THIRD repo". It was the donor
  invariant 12 describes, so it was the same repo, not a third.)
- **`og:url` on a shell was the half nobody wrote down.** This repo did not blank it (which
  invariant 12 warns about); it set it to the ORIGIN, which is a different wrong: every share of a
  dead link unfurls as the home page. The package strips it, and the app's two other shells —
  `app.html` and `record.html`, which are the raw template rather than a bake — needed the same
  three tags removed by hand.
- **A rule can only be enforced if the template carries the tag.** The old rig APPENDED a canonical
  before `</head>`; the package REPLACES one, and refuses a template without it. So `index.html`
  gained a `<link rel="canonical">` it never had. That is the point: `String.replace` with no match
  succeeds, so the enforceable version needs something to fail against.
- **An adopter's API convention came up into the package.** The first adopter's server names a
  sentence with `messageKey`; this one has no such field and lets the **`code`** name it — 98 of
  them, `errors.FORECAST_NOT_FOUND` and siblings — which its client resolved itself. That is how
  i18n ended up inside a transport. `serverSentence` now reads the code under the same prefix and
  through the same `knownMessageKeys` gate, after `messageKey`. Second convention, same claim.
- **A version bump can be forced by a pin you cannot see.** `@gusnips/vite` depends on
  `@gusnips/react` at `workspace:*`, and npm rewrites that to an EXACT version at pack time. A
  react release therefore obsoletes the published vite: left alone, an adopter taking the new react
  gets a second nested copy of it under vite, with a second `PRERENDERED_ROUTE_ATTR`. The two ship
  in lockstep, react first.
- **Two audit findings did not survive contact with the code.** The audit said this repo sends no
  `og:locale` (it does, `pt_BR` plus two alternates, in `index.html`) and that its two robots files
  disagree about the domain (both name the same one). Neither went into a commit message. **Re-read
  before you write the finding down** — an audit note ages, and a bug claimed in a commit that was
  never true is worse than one that was never found.
- **The dead code was in the CALLERS, not the file.** The app's second SSE transport carried a
  reconnect loop with backoff, a retry ceiling and three toasts — and both call sites passed
  `maxRetries: 0`, because the store above them has its own reconnect loop with its own deadline.
  Two dozen lines that had never run once, including a toast-per-attempt bug that could therefore
  never fire. Its `onClose` option was the same story: forwarded through two layers, set by nobody.
  Reading the file tells you what it does; reading its callers tells you what it does HERE.
- **A second transport does not stay a copy — it stays the OLD copy.** That same file had its own
  fetch, its own auth header, its own 401 retry and its own toasts, and not one fix made to the
  real client had ever reached it: the retry re-sent the token that had just been refused rather
  than refreshing it, nothing bounded the handshake, a dead session never redirected, and a fresh
  OAuth sign-in opened a stream before the account row existed. None of it was visible as a bug
  in that file — every line was reasonable when it was written. Routing it through the app's one
  client fixed four things at once and deleted 84 lines. It also killed the app's last
  `getAuthHeaders()`, which existed only to hand that transport a token.
- **Not migrating something is a result, and it is measured, not felt.** This repo's three auth
  stores are a strict superset of `createAuthStore`: each adds `isAnonymous` (denormalized from
  the user), and two add real product state the kit's fixed shape has no slot for — a
  post-login layout-restore guard, a one-shot sign-out notice. Adopting the factory would save
  about 25 lines and rewrite ~70 call sites (39 read `isAnonymous` off the store, 33 call
  `clearUser`). That is a migration that grows the risk and not the value, so it did not happen —
  and the finding is what the kit is missing, not that the adopter is wrong: a fixed store shape
  fits an app with no extras and nothing else. The first adopter's is one line; this one's cannot
  be.
- **A guard every adopter writes is a bug in the package.** Web, admin and mobile each checked
  `!message.startsWith("Request failed (")` before showing an error — three copies of one test
  against a string the PACKAGE writes, when an answer has no envelope and so no words of its own.
  The describer had no such check, so in the first adopter a gateway answering with HTML while the
  API restarts would put `Request failed (502)` on screen as the cause. The fix went into the
  describer (0.4.2) and all three copies were deleted. When the same defensive line shows up in
  every adopter, the thing it defends against is ours.
- **Describe at the edge that renders, never earlier.** The rewards store caught an API refusal,
  translated it, and rethrew `new Error(translatedText)` so a modal could show `err.message`.
  That works until anything reads the error as data: to a describer, an error that is not an
  `ApiError` is a request that never landed, so the modal would have said "check your internet"
  for "you already own this". Rethrow the error itself; turn it into words where it is shown.
  The same feature on the phone had its own translator, too, and the two disagreed about what an
  unknown code says — one showed the server's sentence, the other a flat "something went wrong".
- **The describer's one assumption is wrong for a second vendor.** Anything that is not an
  `ApiError` reads as "the request never landed", which is true for `fetch` and false for
  supabase-js: its `AuthError` is an answer, with a status and a `code`. Handed over as-is, a wrong
  password says "check your connection". This repo converts at its own edge — the `code` into an
  `ApiError`, the message dropped, because GoTrue's is English-only and often names the wrong
  cause — and resolves it under a second prefix. One adopter does not make that the kit's job;
  the second repo on Supabase Auth that needs the same six lines does.

## Migration 3 (−108 lines, 4 commits)

The first adopter on Firebase Hosting, the first whose apps have no react-query, and the first
whose CI runs no tests. Each of those moved a lesson somewhere it had not been before.

- **The file form is the host's call; the rule under it is not.** Invariant 5 said flat files,
  and that turned out to be a fact about Cloudflare Pages. Firebase Hosting redirects `/precos`
  to `/precos/` by default, and serves `precos/index.html` at `/precos` itself once
  `trailingSlash: false` is set. This adopter keeps the directory form, with the reason beside
  the line that names the file. Invariant 5 now leads with the rule that holds on both hosts: an
  address the app advertises answers 200.
- **The host's redirect also broke hydration, and nothing showed it.** Before that flag, the
  address bar said `/precos/` and the file said `/precos`. The entry compared them exactly, so
  every prerendered body was thrown away and drawn again, on a page that looks the same either
  way. The adopter had written its own slash-tolerant compare; `hydrateOrMount` has it now
  (0.4.4), so the next host cannot bring it back. The same adopter needed `null` for the other
  reader no file fits: its site prerenders one language and picks the reader's at runtime.
- **Invariant 12's bug was live in a third repo, and in this file.** The 404 advertised
  `/og/__not-found__.png`, a file its card generator has never rendered, and an `og:url` at the
  dead address. Reading the shell branch against the package found the other half: invariant 12
  said `canonical: null` "takes `og:image` with it", and the code never did. The docs were fixed,
  not the code, because a shell carrying the brand card is correct and `bakeHead` cannot tell a
  right `image` from a wrong one. The build can — an advertised card that is not a file in
  `dist/` — and now does: `assertOgImages(distDir, origin)` (0.4.6) reads the pages the build
  wrote and checks each card it advertises against the disk. It reads the OUTPUT rather than the
  registry on purpose, because the registry is exactly what the broken pages are missing from.
- **An old rig can know a tag the package does not.** This one wrote `og:image:alt` per page.
  `bakeHead` swapped the image and kept the template's alt, so every card would have been
  described with the front page's title, on the one tag written for somebody who cannot see the
  picture (0.4.4).
- **Check the deployed page, not only the diff.** Built before and after, every head was
  byte-identical except the 404's. `curl` on the live 404 then showed two robots tags: the
  template's `index, follow` and an appended `noindex`. The old rig appended it, and so did
  `bakeHead` — the extraction copied the bug faithfully. It now rewrites the template's tag
  (0.4.5). A byte-identical diff proves a migration kept the behaviour. It cannot tell you the
  behaviour was right.
- **Two donors named one way an i18n flag breaks; the third migration found the other.** Both
  donors' comments say `nonExplicitSupportedLngs` renders a region-coded `pt-BR` catalog in
  English. This adopter's catalogs use base codes, so its copy was right. But an `en-US` browser
  kept `"en-US"` as `i18n.language`, the site's `<html lang>` lookup keyed by `"en"` missed, and
  English and Spanish readers got `lang="pt-BR"` over their own language. The package's test had
  only asserted that the flag was absent. It now starts a real i18next and checks both the
  language and the catalog that answers, for both catalog shapes.
- **The package already had the fix; adopting it is what found the bug.** The shared error
  boundary reloaded after any chunk failure with no memory of having done it, so a chunk that was
  really gone reloaded the page every three seconds, forever, with the person inside.
  `reloadOnce` has guarded that since the audit. The same class's matcher missed
  Firefox's wording, the second hand-written matcher to do so after migration 2's sibling app,
  and it never cleared, so a crash on one screen was still there after the back button.
- **An error screen's words are a claim, and this one was false.** The crash page said the
  engineering team had already been notified. Nothing in the web app, the admin or the shared UI
  package reports an error anywhere. It now says what happened and what to do next.
- **Put a guard where CI will run it.** `--color-input` measured 1.12:1 in light, the third
  adopter of three under the token contract's floor, and the controls did not use it anyway: the
  shared ones drew `border-gray-300` at 1.24:1, and 21 fields bypassed the shared controls with
  class strings of their own. The first guard written was a contrast test. This repo's CI runs
  lint, typecheck and build, and no tests, so the test would have passed on a laptop and never
  run where it counts. The token generator refuses to write a value under 3:1 instead. **Read
  what CI runs before you choose where a check lives.**
- **Not migrating the transport, measured.** Web, admin and the phone each carry an axios client
  (525, 455 and 466 lines) that 29 service classes extend, with no react-query over them and no
  tests in CI. Replacing it means rewriting every service with nothing to catch a regression, so
  it waits for a migration of its own. Reading it still found four bugs for that list. It counts
  401s rather than failed refreshes and signs out on the third, so three requests that 401
  together sign the person out while the refresh they are waiting on is still in flight — the
  invariant 3 bug, reached a new way. Every web request carries a 16-minute timeout, sized for the
  largest report upload. With no token stored, a request still sends a `Bearer undefined`
  header. And a gateway 5xx with no body shows generic text.

  **All four were then fixed in place, and that is the lesson: a migration you decline still pays,
  if you write the bugs down.** None of the four needed the package. What they needed was somebody
  reading three copies of one file against each other, which is what a migration is even when it
  ends in "no". Two of them only came out that way: removing the 401 counter was impossible until
  the apps could tell a dead session from an unreachable one, and the counter turned out to be the
  only thing ending a dead session in the admin app — which had no dead-session path at all,
  because the app next door had one and nothing merged them. **The sibling app is the finding, for
  the third migration running.** The fix that landed is the one the package already teaches
  (invariant 3, `reachedAuth`), arrived at from the other end: not "adopt `createApiClient`", but
  "only auth answering no ends a session", applied to the transport the repo keeps.

- **`createAuthStore` met its second superset.** This adopter's store holds the session, a
  profile row, a remember-me choice that decides where the token is kept, and the sign-in methods
  themselves, with a React context beside it. Migration 2's stores added other fields for the
  same reason: the kit's shape is fixed and product state has nowhere to go. Two adopters in a
  row makes that the package's gap to close, not an adopter's quirk.

  Closed in 0.4.6, and the shape came from reading both supersets rather than from the phrase
  "extension point". `createAuthStore` owns its `create()` call, so it owns the whole store: no
  middleware, no extra action, no extra field. `authSlice` returns the same flags as a plain
  object to spread, and the adopter keeps `create`. The second argument is the part a generic
  slot would have missed — migration 2's stores derive `isAnonymous` from the user, which means
  it has to be rewritten by `setUser` and `clear`, the two writes the product no longer owns.
  That flips migration 2's measurement: the ~70 call sites it would have had to rewrite were
  only in play because `isAnonymous` had nowhere to live. **The gap was not "a fixed shape", it
  was "a fixed shape AND fixed writers"** — and only the second one costs call sites. The other
  superset still does not adopt, and that is the honest result: a 235-line store of sign-in
  methods under `persist` is product code that happens to hold a session, not plumbing.

## Migration 4 (−233 lines, 3 commits)

The first adopter that was **ahead of the package**, and that changes what a migration produces:
three separate fixes landed in the package FIRST, because adopting it unpatched would have been a
regression. A migration is not only "what does this repo lack" — it is also "what does the package
still get wrong, that only this repo's shape reveals".

- **Two guards for one regression, and neither could fire.** `assertRendered` refuses a page whose
  body is a loading screen. This adopter's looked for a spinner class its splash does not use. The
  package's was anchored at the root's FIRST tag and would have missed it too, because this splash
  centres its live region inside a `<main>`. Two independent checks against one failure, both
  written carefully, both dead. **A guard that has never fired is not evidence that it works** —
  and the only way to find out is to feed it the thing it is supposed to catch. Fixed in the
  package first (0.4.7).
- **A tag the package wrote in one spelling only.** `bakeHead` matched the `twitter:` tags by
  `property=`; this adopter's template spells them `name=`. `String.replace` with no match
  succeeds, so adopting it unpatched would have frozen all 48 prerendered files at the front door's
  card, in three languages, with nothing in a browser to show it. It now writes whichever attribute
  the template carries (0.4.7). Same class as the canonical bug in migration 1: a silent no-op is
  worse than a missing feature.
- **A guard can be worth adopting where it finds nothing.** `assertOgImages` reads every advertised
  card against the disk. This adopter passes it today, because it advertises one brand card
  everywhere — so it is not a fix here. It is what stops a per-page card quietly reintroducing the
  bug three sibling repos shipped. **"Already correct" is a reason to take the guard, not to skip
  it**, because what it pins is the thing a future change would break.
- **The file that decides every published page was typechecked by nothing.** `scripts/` was in no
  tsconfig's `include`, so neither `tsc -b` nor CI ever read the rig that writes every head, every
  canonical and the sitemap. It is in `tsconfig.node.json` now, which extends the React config
  because a prerender is a Node process that typechecks browser code. Read what your tsconfig
  actually covers; an `include` that misses a directory fails by saying nothing at all.
- **One predicament, three detectors, and the guard belongs to the tab.** A deploy landing under an
  open tab breaks it two ways and only one looks like a missing file: the next navigation asks for
  a chunk whose hash is gone, or the old bundle reads a field the API has renamed and throws a bare
  `TypeError`. Message matching is blind to the second by construction, so the server probe two
  adopters had written independently came up as `isStaleBuild`. It asks for the **page**, never the
  asset — a CDN serves assets with a long `s-maxage`, so a bundle retired an hour ago still answers
  200 from the edge and would report "current" during exactly the window when skew is likeliest.
  The two donors disagreed on the comparison, and the tiebreak was the failure DIRECTION: the
  anchored `src="…"` match is more precise and breaks if anything rewrites the markup on the way
  out, where a minifier changing quote style is enough — and breaking there reports a healthy tab
  as stale, a reload nobody can refuse.

  The rename is the half the adoption uncovered. Three detectors for one predicament, each with its
  own once-a-minute key, hands a broken deploy three reloads a minute to take turns with — which is
  exactly what this adopter would have got, its own probe on one key and the package's on another,
  each resetting the other's clock. `reloadOnceForChunkError` → `reloadOnce`, one key
  (`frontkit:reload-at`), exported because the one caller that cannot import it is an inline
  `<script>`. Breaking, so 0.5.0 — and a caret on a 0.x does not cross a minor, so the adopters on
  `^0.4.x` were untouched until they bump deliberately. **Check the range before paying for
  compatibility you do not owe.**

- **The deepest fix was in host config, which no package can ship.** A static host answers a missing
  `/assets/x.js` with the SPA fallback — `index.html`, 200, `text/html` — and that IS the browser's
  "MIME type text/html" module refusal. Hosts then match cache rules against the REQUEST PATH
  rather than the outcome, so an `immutable, max-age=31536000` rule written for hashed assets lands
  on that HTML body and poisons one asset URL for a year. This adopter removed the cause at the
  edge, with middleware turning a guarded miss into a real, uncacheable 404; a sibling repo built
  three layers of recovery around a cause it never removed. The package cannot ship either one, so
  the module doc and the README name it. **A package that cannot fix a cause can still refuse to
  let it go unwritten.**
- **`tsc` never removes output it did not just write.** `@gusnips/react@0.5.0` reached the registry
  carrying both `deploy-recovery.js` and the `chunk-reload.js` it replaced, because every package
  built with a bare `tsc` and `files: ["dist"]` ships whatever is sitting there. The dead copy was
  unreachable through the exports map — which is what made it worth fixing rather than shrugging
  at, because it still declared the old key that very release existed to remove, in a published
  artifact for somebody to grep a year from now and believe. Builds clean `dist/` first, and
  `release:check` now reads the packed tarball for `dist` files with no `src` behind them: a clean
  script is a claim about a command, the tarball is what the registry receives. **Verified by
  watching the new check fail before fixing what it caught** — against the dirty tree it named
  `dist/chunk-reload.*` and nothing else, with no false positive on the nested `react/src/ui/*` nor
  on `tokens`, which emits no `dist` at all.
- **The package shipped a bug this adopter had already avoided.** `i18nInitOptions` hardcoded
  `caches: ["localStorage"]`, so the detector wrote the stored locale back on every
  `changeLanguage`. That is right until an app offers "follow the browser": reaching that state
  means clearing the key and detecting again, and a caching detector writes the language it just
  detected straight into the key it was told to clear, so the choice re-pins itself and the option
  becomes unreachable. Three repos on this stack answer this three ways — the detector writes, the
  app writes, or both do — and the third is harmless only where there is no "follow the browser"
  state to break, which is how one hardcoded answer survived this long. `storageWriter: "app"`
  turns the write off and leaves the read alone (0.5.2). One writer per key, the same rule the
  reload guard arrived at from the other end.
- **A measurement that came out against the hypothesis, and that is the result.** The expectation
  was that this adopter's optional `detail` would challenge `EmptyStateProps.description` being
  required. Every one of its twelve empty-state call sites passes it, so the required field is
  confirmed rather than contradicted. The contract still did not get adopted — this adopter's prop
  names differ (`detail`, `children`, `footer`), so taking the type means renaming across twelve
  files for no behaviour change. Two honest outcomes from one reading, and neither is a commit.
- **A describer worth more than ours, and the answer was neither donor's design.** This adopter
  routes failures to catalog KEYS, carries a machine-readable recovery kind, and keeps the raw
  provider string; `createErrorDescriber` returned two resolved strings. Three differences,
  measured — and only two were worth anything, which is why this landed additive (0.5.3) rather
  than as the breaking rewrite it first looked like.

  **`recover` is the one that mattered, and copying the adopter would have been the wrong fix.**
  Both donors hardcode a recovery per error code, beside a `shouldRetry` already answering the
  same question for react-query. Two answers to one question drift, and this drift is visible: a
  screen offering "try again" for a refusal the query layer has already refused to retry, so the
  button does nothing and the reader presses it twice. So it is DERIVED from `shouldRetry` —
  one rule, two consumers, invariant 8 owning both. An arm can still narrow it, which is exactly
  what a spent quota needs: a 429 the rule would otherwise call `"wait"`.

  `reference` is the second, and it was free. `ErrorStateProps` has reserved a slot for a request
  id since the contract was written and nothing ever produced one to put in it. The same pass
  finally reads `expected` — the flag on the 401 the CLIENT raises during sign-out — so an error
  surface stops offering a retry for something nobody broke.

  The third, keys instead of prose, was **declined**, and that is the honest half. The package's
  `t` re-resolves at the render edge, which migration 2 had already made a rule; its tests assert
  key identity through an echoing `t`, so the adopter's purity argument is weaker against us than
  it reads; and converting the arms in the two repos that call it is a real rewrite, one of them
  nesting a `t()` inside a hint. **The gap was never the return type — it was a decision the type
  had no room for**, and a decision fits beside prose without replacing it.

## Migration 5 (−55 lines, 4 commits)

The first adopter whose migration turned up a bug that was **live on a public, indexed page**, and
the first where two separate declines were each worth more than the adoption would have been.

- **The same bug, in a second repo, in a file with the same path.** Its brand-variable substituter
  declared six placeholder names and matched three of them in the regex beside it, so the legal
  entity, its registration number and its address were substituted nowhere. The Terms and the
  Privacy policy told readers, in all three languages, that the service is operated by
  `{{legalEntity}}` (registration `{{legalEntityCnpj}}`). Measured on the deployed site before the
  fix: 36 raw placeholders across six prerendered pages — the same count as the earlier repo with
  the identical defect. What hides it in both is that `{{brand}}` on the neighbouring line resolves
  correctly, so half the placeholders work and the page reads as fine everywhere anyone looks.
  `applyBrandVars` derives its pattern from `Object.keys(vars)`, so adopting it fixes the class and
  not the instance: **a var you supply is a var that gets filled.** The second occurrence is what
  proves that derivation was the right fix rather than over-engineering — the first one only proved
  somebody had made a typo.
- **A decline can name the package's next gap more precisely than an adoption would.** `authSlice`
  did not land here, and measuring why found the seam it is missing. `derive(user)` covers product
  state COMPUTED FROM the user. This adopter holds an operator-impersonation token that is not
  computed from the user — it comes from session storage and an admin action — yet sign-out must
  still reset it AND remove its storage key, because that token is bound to the operator's own
  session. `clear` is a fixed writer with no seam for that, and spreading an override after the
  slice leaves a live `clear()` that does NOT end the impersonation sitting beside the app's own
  `clearUser()` that does: a sign-out footgun worse than the duplication it would remove. That is
  the **second** instance in the fleet — another repo's store carries a one-shot sign-out notice,
  which is the same class of state. **It was deliberately not built**, and that is the other half:
  unlike the gap `authSlice` itself closed, closing this one would produce no adoption today, so
  designing the seam now would be designing ahead of the code.
- **A measured decline needs a ratio, not a feeling.** `cn` is two byte-identical seven-line copies
  in one repo and the package ships the same function. Adopting it saves six lines and touches 168
  files — a worse ratio than an adoption already declined at ~25 lines for ~70 call sites. Nothing
  in it can drift, either: no options, no config, no product decision, which is exactly why all ten
  repos wrote it identically. And in a shared tree the purely mechanical rewrite is the change most
  likely to collide with work you cannot see.
- **The adopter's own test named the right home for a shared constant.** The list of refusals that
  do not clear by waiting is taken twice — once to decide whether to retry, once to decide which
  control to offer — so it has to be declared once. It went into the query client first, which put
  shared DATA inside the module that constructs a side-effectful singleton. A store test that mocks
  that module wholesale then read the constant as `undefined`. The failure was the altitude error
  talking: it belongs beside the error-code union it describes, where the comment stating the rule
  already lived, and where nothing has to be instantiated to read it.
- **A net-POSITIVE slice can still be right, and saying so beats hiding it.** The describer returns
  four things; this app rendered one, so the package was computing "what to do about it" and every
  error surface dropped it — 53 of them, all fixed in one file, because all four come from the one
  call that already yielded the cause. That slice is +29 lines. The net-negative rule is about a
  migration, and its reason is duplication: an adopter that GROWS because the cut line was drawn
  wrong. Rendering output the package already computes is not that, and the honest move is to state
  the number and the reason rather than pad the diff elsewhere. The migration closed at −55.
- **Check the vendor's own entry before adding a dependency — and resolve it the way the app
  does.** Invariant 3 needs the auth library's retryable-error predicate, and the module doc
  suggested an adapter. The first check, run with `node` from the repo root, reported the symbol
  missing and looked like proof a new dependency was needed. It was not: the package is hoisted
  into a store that node's resolver cannot walk from there, and the vendor's main entry re-exports
  the auth package wholesale. Re-run through the app's OWN resolver, the answer flipped and the
  dependency was already present. **A resolution check is only evidence when it resolves the way
  the consumer will.**

## Migration 6 (−282 lines, 5 commits)

The first adopter already running the package in three apps before the migration started, and the
first whose migration caught the package **contradicting itself** — two halves of one contract,
shipped in the same tarball, disagreeing about the name of a field.

- **A line every adopter writes is a fact the package failed to record.** Six prerender scripts
  across five adopters already ended with `process.exit(0)`, and every one of them was written
  against a DIFFERENT holder: an auth client whose token-refresh timer starts at module scope.
  None of them knew the renderer invariant 1 requires does it too, so the sixth adopter
  rediscovered it from scratch — through three refuted hypotheses and two builds killed by hand.
  This is migration 2's rule ("a guard every adopter writes is a bug in the package") arriving
  from the other end: the package could not fix the cause, so what it owed was the sentence.
- **A rename adapter in every adopter is an API we got wrong.** `ErrorStateProps` — the contract
  this package ships for the component that renders a described error — has always called the
  second half `fix`, while the describer returned `hint`. Every adopter wrote `fix={hint}` at
  every error surface, and `states.ts` had been documenting a `fix` the describer never returned.
  The tell that the rename was right rather than merely tidy: it made an existing doc comment
  TRUE instead of forcing an edit. It also cleared a collision, because in an adopter a form
  field's `hint` is the requirement text under the input.
- **A default whose price is invisible is not a kindness.** The describer humanized a stated wait
  itself, which put three ICU plural keys into the key union of every adopter's `t` whether or not
  a wait was ever rendered. Measured for one adopter through `Intl.PluralRules`, that is **24
  catalog entries** — three keys across one language's two plural categories and two languages'
  three — to satisfy a compiler for copy it already formatted correctly with
  `Intl.RelativeTimeFormat`. `formatWait` is required rather than defaulted, so the catalog you
  need is the one you can see; `humanizeWait` is still exported and is now what you pass.
- **The drift was real and ran the opposite way from the prediction.** The expectation was a "try
  again" offered for a refusal the query layer refuses to retry. Measured, it was the reverse: two
  503s that never clear on their own were shown as "write to us, no retry" while `shouldRetry`,
  seeing only a 5xx, spent two more requests and about three seconds of spinner on each. Deriving
  the button from the retry rule is what surfaced it, and the fix was one shared list rather than
  either consumer changing its mind.
- **Count only the raisers whose error reaches the wire.** A third 503 in that same family was
  left off the list because it had two raisers: "not configured on this deployment" (durable) and
  "did not answer just now", which the server tags `severity: "transient"`. The envelope carries
  no severity, so this bullet called it a contract gap the client could not close. **That was
  wrong, and a re-read on 2026-09-27 showed why.** The transient raisers are job failures. The
  server writes them to a job row with their own severity, and they never travel as an HTTP error.
  The one raiser a client meets is the check at job creation, and it reads configuration only, so
  it clears with a deploy and never with a wait. The code joined the list, and the SDK beside it,
  which had treated it as final all along, was right. A search for who raises a code answers a
  different question from where that error goes. What made the fix cheap was the reason written
  beside the list: **declining to guess is an outcome, and an undocumented guess is not**, because
  only a written reason can be checked and reversed.
- **A bug class checked and found absent is a result worth the reading.** Migration 5's brand-var
  substituter bug — names declared but not matched, so legal text shipped raw placeholders — was
  checked here against the same file shape: four names declared, four matched. Clean. The check
  cost minutes and the alternative was assuming.
- **A byte-diff that changes files is a question, not a verdict.** 82 of 88 prerendered pages came
  out identical, asset hashes unmoved. The six that differed were the 404 shells, which now keep
  the brand `og:image` the template declares where the old rig stripped it — correct per invariant
  12, but only because the advertised card is a real file, which was checked on disk rather than
  assumed. Three sibling repos shipped that same tag pointing at a card that never existed.
- **`scripts/` typechecked by nothing, for the second migration running.** Both apps ran
  `typecheck` against their app tsconfig alone, so the `tsconfig.node.json` beside it — and with
  it every script that writes a head, a canonical and a sitemap — never executed at all. Migration
  4 found this in one repo and it was not a quirk of that repo.
- **Piping a build through `tail` throws away its exit code.** The pipeline reports `tail`'s
  status, so an `&&` chain advances past a failed build and a "completed, exit 0" notification
  means nothing. Two of this migration's dead ends trace to that one habit, including a "hang"
  that was a finished build waiting on the event loop above.

## Migration 7 (14 commits: −169 source across the adoptions, +125 over the range)

The first migration whose total came out **positive**, which made the accounting itself the
finding. Also the first adopter whose auth store was a clean SUBSET of the kit's rather than a
superset — the case three earlier migrations each declined for the opposite reason.

- **"Net-negative" has to name WHAT is counted and WHICH commits.** This range is +125 lines, and
  every part of that is fine once it is split. The seven commits that actually swap the adopter's
  code for this package are **−169 lines of source**. Tests are **+102, in two files** — a
  rewritten describer test and a guard test for behaviour nobody in the fleet had pinned. The
  remaining +178 is not an adoption at all: three live bug fixes, one prep refactor, and a
  cross-origin capability that did not exist before. Reaching a negative total would have meant
  deleting tests or leaving bugs alone. Measure the adoption commits, in source, and state the
  rest out loud.
- **The same dead-looking code meant the opposite thing here, and the SERVER is what said so.**
  Migration 2 found a reconnect loop with backoff and a retry ceiling that had never run once,
  because both callers disabled it. This adopter's stream client has that same shape and it is
  load-bearing in a way no caller reveals: the server ends any stream older than its ceiling
  **with no terminal frame, on purpose** — "a clean close mid-run reads as a dropped socket, which
  is exactly what we want", because an error frame would end the client's watching. The reconnect
  IS the continuation path for a long run, resuming from `Last-Event-ID`. Reading the callers
  answered migration 2; reading the producer answered this one. When a shape is ambiguous, the
  other end of the wire is the authority, and it often already has the comment.
- **Read the serializer, not the emitters.** The blocking question was whether that wire ever
  carries a frame with no `data:` line, which this package's parser drops by design. Grepping the
  code that emits frames was the wrong move and cost two passes: every frame there funnels through
  ONE `write` that always sends `data: JSON.stringify(...)`. One file answered for all of them,
  and handed over the rest of the slice's facts on the way — a 15-second heartbeat, and an `id`
  only where the producer numbers frames.
- **Two package bugs, found by the function-by-function read, neither visible in a green suite.**
  The describer gated known message keys on `Object.keys`, and i18next stores a plural as
  `name_one`/`name_other` while a server names the BASE — so **2 of that API's 112 thrown keys**,
  both plan limits, would have fallen back to the server's English at exactly the moment the
  specific sentence is the whole value. And the unmapped-code arm hands the reader `error.message`,
  which is right for the API of migration 2 (where the code names the copy) and exactly wrong for
  an adopter whose own docs call `message` the English line for the log: every coded 4xx with no
  key would have put developer English on screen in a three-language product. Both fixed in the
  package first (`fallback` takes an arm; the gate admits plural bases). **The old file's tests all
  passed against the old file** — which is the blind spot that rule exists for.
- **A language crosses in the URL or it does not cross.** A storefront and the app it sells are
  different origins, so they share no `localStorage` however identically the key is spelled — and
  a reader who picks a language on one and clicks through gets the browser's guess on the other,
  turning a choice they just made into a guess. `queryKey` exists for this. The half that is easy
  to miss: **a GET form REPLACES its action URL's query with its own field set**, so a language
  carried in the action is discarded the moment the form submits — on precisely the no-JavaScript
  path that is the reason the form is a real form. It rides as a hidden input or it does not ride.
- **React 19's static render writes the PROP name, not the attribute name.** `hrefLang="es"`
  reaches the HTML in camelCase. Browsers parse attribute names case-insensitively so the page is
  correct, and every grep written for the real spelling reports zero — which is how a verifier came
  back saying a build had no language links when it had all of them. Grep the built output for what
  React EMITS, not for what the spec calls it.
- **The first auth store that was a subset, and it still closed a gap.** The factory went in
  outright with zero call-site changes, because the adopter's guards were already taking that store
  as `SessionState`. What it fixed on the way is the thing the factory's own doc predicts: the
  package's `setUser` ends the loading state in the same write, where this store left `isLoading`
  alone and relied on a separate call. Here that call covered the boot lookup and **nothing covered
  the other path** — a session arriving through the auth channel while the lookup was still in
  flight set the user and left every guard on its loading screen. Three declines made the factory
  look like the wrong shape; the first subset showed the shape was right and the adopters were
  supersets.
- **A dead export survives a green gate when the tool calls it a hint.** A deleted module left its
  subpath behind in a package's export map. Nothing imported it, so nothing broke, and the dead-code
  check reported it as a configuration hint rather than an error — which is exactly how an entry
  like that outlives the person who remembers what it was for. An export map is a claim about what
  a package offers; this one advertised a module whose removal was the point of the commit.
- **`%CPU` is a lifetime average, and the evidence dies with the process.** A gate hung for
  12m40s and `ps` reported the stuck process at 99.9% CPU, which reads as an infinite loop. It was
  not: macOS averages `%CPU` over a process's whole life, and a `sample` showed every thread parked
  — blocked, not spinning. Sample before you kill. Two more from the same hour: a killed gate exits
  **143**, which is not a failing gate and must not be read as one, and zsh does not word-split, so
  a watchdog stashed in a variable is looked up as a command with a space in its name.

## Migration 8 (−185 lines, 6 commits)

The first adopter whose own rigs were good enough that the migration looked, going in, like pure
deduplication. It produced the strongest finding in the project so far, out of a file nobody had a
reason to open.

- **`renderToString` does not only render the fallback. It renders its own ERROR, into the page.**
  Invariant 1 had the gentle half. What this adopter shipped on a live, indexed reference page was
  React's "The server used renderToString which does not support Suspense" message, a stack trace,
  and five copies of an absolute path from the machine that ran the build. Nothing in a browser
  shows it — the bundle replaces the body on load — so the only readers who ever saw it are the
  ones who run no JavaScript, which is every crawler the prerender exists to serve. **It was in one
  of the page's two languages**, and that is the half nobody would guess: the first render suspends
  and bails, but it also resolves the `lazy()` promise, so the next locale in the same loop rendered
  the real component and looked perfect. One loop, two versions of one address, one a stack trace.
  Every cheap check passes it because the error text makes the file BIGGER — a size floor reads it
  as a full page, and the splash check is gated on a small file for the reason that gate exists.
  `assertRendered` refuses the signature now (0.8.1); it can only fire for an entry still on
  `renderToString`, which is the point, because those are the repos that have not read this.
- **A blocker dissolved by two commands that the audit had reasoned about for a paragraph.** The
  plan said adopting `renderTree` could hang the docs build, because the reference route fetches a
  live document and `react-dom/static` resolves Suspense where `renderToString` does not. Measured:
  the renderer imports fine with no DOM, and the hook behind it is an ordinary effect-driven state
  machine, so a build renders its loading branch and never touches the network. The guess cost a
  paragraph; checking it cost two commands. **Measure the blocker before you design around it.**
- **A slice order drawn from an audit can be wrong about a dependency the audit never had to
  execute.** The plan put the retry rule first and the transport second. Impossible: the kit's
  `shouldRetry` narrows on the kit's `ApiError` and the app still threw its own, so the drift could
  not be fixed until the transport landed. Reordered on contact with the code.
- **The green gate caught neither regression the manual read caught.** Swapping the transport made
  `String(error.code)` print the literal word "undefined" beside a request id (the old class always
  had a code; the kit's leaves it absent when there is no envelope), and made the transport's own
  `Request failed (502)` the sentence shown as the problem. Both shipped past a full green suite.
  This is the rule at the end of this file, earning itself again.
- **The third repo with the split-origin language bug — and the fix was already in the package.**
  `queryKey` was written for one donor with a storefront and an app on separate origins. This
  adopter has the same layout and the same hole: `localStorage` is per-origin, so one key NAME with
  three stores behind it, and a reader who picked a language on the storefront landed in English
  across ten links. Its own comment had concluded a cookie was what that would take. The whole
  point is the third repo, again.
- **An adopter AHEAD of the package, recorded rather than built.** `resolveKey` returns the KEY on a
  miss; this adopter's equivalent throws. At a call site feeding `<title>` and `description`,
  returning the key ships a raw catalog key to a crawler on a live page. The adopter is right and
  the package is weaker — but it can do this itself in fifteen lines, so it stays a note. One
  adopter's stricter policy is not yet the package's gap.
- **Invariant 15, reached from the adopter's side.** `pageSlug` and `ogImagePath` are byte-
  equivalent to the package's and were still declined: the adopter's page registry is import-free
  ON PURPOSE so the browser bundle can read it, and those helpers sit in the barrel whose node
  module imports `node:fs`. Taking them would pull Node into a browser bundle. **The rule cuts both
  ways — sometimes the adopter is the one who must not import.**
- **A note in your own roadmap ages like any other comment.** The constraint was written down as
  "81 non-frontend importers". Re-measured while checking it: 150 importers, 44 in the frontends,
  so 106. The constraint was stronger than its own record. Re-read before quoting yourself.
- **When a migration changes every file, assert the SHAPE of the change.** Adopting the shared rig
  moved `og:locale` from replaced-in-place to stripped-and-appended, so all 38 prerendered pages
  differed and a file-by-file read would have been theatre. The check that meant something was
  mechanical: normalise the bundle hashes, then assert that **no changed line was anything but a
  console href** — 38 changed, 0 unexpected. A diff too big to read is not a diff you skip; it is
  one you write a predicate for.
- **Two slices were net POSITIVE on purpose, and saying so is the point.** A crash screen and a
  language that survives a subdomain hop are capabilities the repo did not have at all; a blank
  page costs zero lines. Migration 5 settled that this is not the duplication the net-negative rule
  exists to catch. The migration closed at −185 without anything being trimmed to get there.
- **`git diff --name-only` cannot see a file git has never seen.** Formatting the changed files
  through that pipeline silently skipped the one new test, and the gate failed on it. A "changed
  files" pipeline that feeds a formatter needs the untracked ones too.

## Migration 9 (−81 lines, 3 commits)

The last of the nine, the smallest, and the first where the package had to correct **itself** —
twice, once for a comment it had inherited and once for a claim this migration put into an
adopter's history before measuring it.

- **A grep proxy is not a measurement, and it was wrong three times in one sitting.** The sweep
  asked "does this entry-server call `renderTree`" and reported 17 of 19 as still on
  `renderToString` — an alarm that would have opened pull requests against a dozen healthy repos.
  Re-asked as "what does this file actually import", the answer was **zero**: seven go through the
  package, twelve reach `react-dom/static` directly, pre-kit. The follow-up query repeated the
  error one level down, matching the word `renderToString` inside comments explaining why the file
  does not use it; a third pass counted `lazy(` in a comment saying no route is lazy. What settled
  it was the built output — grep every `dist/` for React's own error sentence — after the detector
  was first run against a file known to contain it. **A search that returns nothing proves nothing
  until you have watched it find something.**
- **A guard's reach is the caret, not the publish.** The `renderToString` check shipped in
  `@gusnips/vite@0.8.1` and was written specifically for adopters who have not migrated. They sit
  at `^0.4.3`, `^0.4.6`, `^0.5.2`, `^0.5.4`, `^0.6.0` and `^0.6.2`, and a caret on a 0.x does not
  cross a minor — so **not one of them can receive it**, and the only repo that can is the one that
  no longer needs it. Migration 4 learned to check the range before paying for compatibility; this
  is the same fact from the other side. A guard reaches nobody until each repo deliberately bumps,
  which makes the bump the deliverable, not the guard.

  **Those six numbers are a reading, not a standing fact, and one got quoted as a standing fact
  six weeks later.** Re-measured 2026-09-21 across every `package.json` on `origin/main`: all
  thirteen adopters now sit at `^0.9.x` / `^0.8.x`, so a release into 0.9 reaches every one of
  them without a bump. An agent building the server-side twin was told the opposite — "the
  deliverable is the bump in each repo" — straight out of this bullet, and would have designed
  around a problem that no longer exists. The lesson above is unchanged and the list under it
  expired; what makes it safe to keep is the date beside it. **A version list in this file is
  evidence for the sentence it appears under, never an answer to ask it for.** The current answer
  comes from the resolver: install the range into an empty directory and read what lands, which
  also shows whether two copies come with it.

  And the blocker that replaced it is one this file already names from the other end: one adopter
  declares `^0.9.0` and resolves **0.8.0**, because bumping a version does not update the lock.

- **The comment that was wrong, and the six lines it cost.** This rig carried a second meta setter
  because a comment said the first one's pattern "cannot see" a tag whose attributes span three
  lines. `[^>]*` is a negated character class; it matches newlines. Run against the real template,
  both patterns match every multi-line tag in it, and the second one's is strictly the narrower.
  Two call sites and six lines for a problem that never existed — and the test beside them asserted
  the behaviour while crediting it to the wrong function.
- **And the one this migration got wrong itself.** `pageFile`'s comment said a flat file is served
  at `/pricing` AND `/pricing/`, "200 either way". That sentence was repeated into an adopter's
  commit message as a live hydration bug. `curl -I` on the deployment: the slashed form answers
  **308** with `location:` the unslashed one, which then answers 200. The host normalizes before
  the bundle runs, so the slash-tolerant compare **cannot fire there at all**. The rule survives —
  the advertised form is the one that must be a page, and it is — but the parenthetical was a donor
  comment nobody had checked, and the README's own next paragraph says to run that `curl -I`.
  Adopting the shared compare is still right; claiming it fixed something live was not.
- **The sibling finding, inside a single file tree.** One screen refuses to navigate on an
  unconfirmed session and writes down why: "navigating anyway would bounce the just-authenticated
  user back to login with no explanation." The gate next door read _every_ `/me` failure as "signed
  out" — a 401, a dropped connection and a 502 mid-deploy all landing on one `setMe(null)` — and
  redirected to the login form. So a signed-in person on a flaky connection was sent to sign in
  again, to fix a session that was never broken. Invariant 3, reached a fourth way, in a context
  provider rather than a transport, with the fix already written one file away.
- **A verification script is code, and it can be wrong in the direction that flatters you.** The
  bundle-hash normaliser behind the byte diff excluded `-` from its hash class, and Vite's
  base64url hashes contain one. It reported 11 changed files where there were 3 — and it had passed
  the earlier run only because that build's hashes happened to have no internal hyphen. Migration
  4's "a guard that has never fired is not evidence that it works", applied to the tooling doing
  the checking.
- **Four measured declines, one of them a first.** The token package: this brand's vocabulary is
  entirely its own and shares **zero** of the 19 semantic names, so there is nothing to override —
  and with no `--color-input` at all, the contrast floor three earlier migrations failed has no
  instance here. The vite preset: a 7-line config, no placeholders, and **0** imports through the
  `@` alias it would add. The auth store: a React context, with no zustand in the catalog. The
  error describer: it needs a `t` and a catalog of known keys, and this app has no i18n at all —
  one language, written in place. And `cn`, which has **0 call sites**: the first adopter where the
  answer is not a ratio but an absence.
- **What the donor knew that the package did not take.** Its prerender reads the site's origin out
  of the canonical the template declares, rather than from an env var the script would have to
  resolve — one file is the answer for the head Vite ships and for every file written after it, and
  there is no second place for a domain to drift to. Kept as-is. Its `process.exit(0)` comment also
  documents the bun idle-hang independently, from the symptom end, where the package documents it
  from the cause end.
- **Adopting a generator can be proved by the bytes it replaces.** `robotsTxt` took over a static
  file that had the origin typed into it a second time, and the generated output was
  **byte-identical**. That is the whole argument: no behaviour changed, and one place a domain
  could drift is gone.
- **The rig swap was −256; the migration closed at −81.** Two slices added capability the app did
  not have — an error state that states its cause instead of bouncing, and a crash screen instead
  of a white page — and they are stated rather than trimmed to. Migration 5 settled that this is
  not the duplication the net-negative rule exists to catch. Verified the same way migration 8 was:
  normalise the bundle hashes, then assert no changed line is anything but the two deliberate ones
  — 9 of 12 files byte-identical, 3 changed, 0 unexplained.
- **A boundary belongs outside the router, and out of the prerender.** Outside the router because
  the session provider every screen renders under throws before any route does; out of
  `entry-server.tsx` because a boundary inside a prerendered tree can bake its own crash screen into
  the file as that page's indexable body. Both checked against the written output, not reasoned
  about: no prerendered file contains a crash string. The placement has a consequence the fallback
  has to respect — with no router context, every link in it is a plain `<a>`, or it throws inside
  the screen that exists to handle a throw.

## Migrations 10–12 (three sibling repos, −196 source each, one reading)

Three repos that are one product under three brands, and the first time ONE migration's reading
served three adoptions. Their prerender rigs differed by a 404 title and two comment lines, so the
slice that landed in the first applied to the other two verbatim. That is what collapsing the fork
was supposed to buy, obtained through the package instead of through a repo merge.

- **The roadmap's own numbers had aged, and re-measuring changed the track.** It recorded 558
  byte-identical files, a `packages/ui` identical file-for-file, and ~3,050 lines of plumbing each,
  and concluded the three should be merged into one repo. Measured: **429** source files identical
  across all three of ~1,750 shared paths — a quarter, not a fork — with 45 of ~74 `packages/ui`
  files identical, 1,213 shared paths differing between just two of them, and **two of the three
  sharing no git history with the third at all**. The collapse is a multi-week merge; the adoption
  was an afternoon. Migration 8's rule about quoting yourself applies to a plan, not just a comment.
- **Invariant 12, occurrences four, five and six — and this time the code said why.** All three
  advertised `/og/__not-found__.png` on their 404, a file each card generator has never rendered
  because it only renders pages in the registry. The mechanism was one line: the image was computed
  BEFORE the branch that decides a page is a shell, so the shell stripped the canonical and both
  share URLs and kept the card. Six repos now, and the fix is the absence of an argument.
- **Migration 3's double-robots bug, also in all three.** The old rig APPENDED
  `<meta name="robots" content="noindex">` beside the template's `index, follow`, so every 404
  shipped two contradictory tags and left the tie-break to each crawler's own rule. Written down in
  0.4.5, and found in three more repos the first time anyone read the bytes rather than the diff.
- **Grep the sentence — but a paraphrase survives the grep.** The house rule says correcting a
  comment means grepping for its sentence. The flat-file sentence corrected one release earlier had
  three more verbatim copies, which the grep found, and a FOURTH in a test comment phrased
  differently, which it did not. That one surfaced only because the file was being rewritten anyway.
  A wrong idea spreads in paraphrase, and no exact-match search will ever find that copy.
- **A build that changes every run is not a failed migration — it is a measurement problem, with a
  real bug under it.** Two of the three baked a RANDOMLY CHOSEN demo conversation into the front
  page, via `useState(pickRandomIndex)`. Two builds of byte-identical source produced two different
  names, so the byte-diff that proves a migration lost nothing could not run on `index.html` at all.
  What proved it instead was rebuilding until the same variant came up and comparing then —
  byte-identical on the fourth try in one repo and the fifth in the other. The bug underneath is
  worse than the noise it makes: a random value used as SSR state cannot agree with the client's
  first render, so the front page hydrates against markup that is not a render of its own state.
  Both are fixed, and the fix carries its own check: two consecutive builds of one source now emit
  a byte-identical `index.html`, which is worth running against any prerendered page. The rule went
  into invariant 2, because that is what it is — invariant 2 reached from a direction no route
  check can see.
- **Strip before you measure, not after.** The old rigs removed the FAQ JSON-LD from the BAKED page
  while `assertRendered` compared that page against the UNstripped template — so the growth floor
  measured two different documents, short by ~3 KB on one side only. A small page could have failed
  "nothing rendered" while rendering perfectly. Stripping the template first makes the two
  comparable. Nobody had hit it; the rig had carried it latent for as long as it had existed.
- **The optional-peer split paid, and the receipt is a version.** These repos run vite 7 and
  plugin-react 5, where the preset declares vite 8 and plugin-react 6. The install was clean and the
  rig unaffected, because the barrel imports neither and the preset sits behind its own subpath.
  That is invariant 15's payoff stated as something an adopter simply does not have — and it is why
  `webPreset` was declined here, with the version named rather than a shrug.
- **A clean negative on the hole three migrations found.** `scripts/` typechecked by nothing was
  migration 4's finding, then migration 6's, then migration 9's. All three of these repos include
  `**/*`, so their scripts were covered before anyone asked. The check cost one command, and
  assuming would have cost a wrong bullet in this file.
- **The shared tree bit twice, two different ways, and a guard is what made pushing safe.** One repo
  went from clean to nine foreign dirty files in the minutes between the audit and the install;
  another had two unpushed commits belonging to somebody else, so its slice is committed and
  deliberately NOT pushed. Pushing "your own completed unit" in a shared tree means asserting it:
  refuse unless the commits ahead of the remote are exactly yours. The rule about never staging
  foreign FILES has a twin about never shipping foreign COMMITS.

## Migration 13 (an audit of an already-migrated adopter)

The first pass over a repo that had **already** adopted the package, looking only at whether the
adoption was right. It found the package shipping the hazard rather than the adopter, which is the
strongest argument yet for auditing after a migration instead of closing the ticket at green.

- **A return target is written into a QUERY STRING, so it must not carry what a fragment carries.**
  `createRequireAuth` built it as `pathname + search + hash`, and that guard renders exactly when
  there is no session yet — which is the state an implicit-flow callback is in while its client
  reads the fragment. Point an OAuth `redirectTo` at a guarded route and the bounce is
  `/login?next=/app%23access_token%3D…%26refresh_token%3D…`: a refresh token in `Referer`, in
  access logs, and in history. `returnPathFromLocation` keeps the page and drops only a fragment
  carrying a credential, because the page is the part worth returning to and the anchor is the part
  that is dangerous.
- **The default nobody passes was the one that mattered, and it is the opposite of the guess.**
  supabase-js declares no `flowType` of its own, so GoTrueClient's fallback stands and it is
  **implicit**, not PKCE — the callback comes back in the fragment. Across the fleet **10 of 12
  frontends set no `flowType` at all**; two ask for PKCE. Measured through an app's own resolver
  rather than by reading a changelog, because migration 5 already learned that a resolution check
  is only evidence when it resolves the way the consumer will: run from the wrong directory, the
  same question answers differently.
- **A rule stated in a README is not a rule the code keeps.** The README said the guard carries
  "path, query and hash", and it did, literally. The sentence was right about intent and the
  concatenation under it was the bug — which is why correcting it meant grepping the sentence and
  rewriting the claim, not patching the line.
- **The adopter's remaining hole was the one this project has closed five times.** An invite link's
  `?next=` used `startsWith("/")` under a comment promising it would "never follow an external
  URL". It would: a parser folds `//evil.test` and `/\evil.test` into another origin and strips a
  tab before deciding. The comment was the tell — a claim the code one line below does not deliver.
- **A guard reaches nobody until the caret lets it.** Three repos call `createRequireAuth`, at
  `^0.9.3`, `^0.9.2` and `^0.8.0`. The two on 0.9 take the fix on their next lockfile update; the
  third **cannot receive it at all**, because a caret on a 0.x does not cross a minor. Migration 9
  learned this from the guard's side; this is the same fact from the bug's side, and it makes the
  bump the deliverable rather than the release.

  **This bullet first said two repos, and said the one stuck at `^0.8.0` therefore held the live
  instance. Both halves were wrong, and only re-measuring said so.** Three repos call the guard,
  not two — the third adopted after the count was taken, which is what a count does. And the repo
  that cannot receive the fix is the one that never received the BUG: at 0.8.x the guard wrote
  `pathname + search` into ROUTER STATE, with no hash and no query string, so the leak arrived
  with 0.9.0 and left with 0.9.2, and that caret spans neither. Its `redirectTo` points at an
  unguarded route besides. **A stale caret is a missing FEATURE, not a retained bug** — what it
  actually costs there is a destination that still dies on a reload and on an OAuth round trip,
  and a hand-written validator weaker than `safeInternalPath`. The sentence as written would have
  sent somebody to close an exposure that cannot exist, and left the real gap unnamed.

  **Closed 2026-09-21: the third repo is no longer on `^0.8.0`.** It went to `^0.9.4` in the auth
  pass, which is the bullet's own prescription carried out — the bump was the deliverable, and
  what it delivered is the missing feature this bullet named rather than a fix to a bug. Its
  destination now survives a reload and an OAuth round trip, and its hand-written `startsWith("/")`
  validator is gone; `/\evil.test` walked through that one, since a parser folds the backslash
  before deciding where the host ends.

  **And the sentence that closed this bullet — "all three callers of `createRequireAuth` are on
  0.9 now" — was false the moment it was written.** It counted the repo that had just been bumped
  and assumed that was the one the bullet had named at `^0.8.0`. It was not. The third caller sat
  at `^0.8.0` until 2026-09-21, and by then it had already merged a reader that imports
  `AUTH_RETURN_PARAM` from `@gusnips/react/guards` — a symbol that first shipped in **0.9.0**, so
  that repo's typecheck could not pass and its sign-in destinations were being dropped: the guard
  it had installed still wrote router state, and the login was reading a query parameter. Checked
  against the published 0.8.0 tarball, whose `guards.d.ts` exports three factories and nothing
  else, rather than against the changelog. Bumped the same day; all three callers are on 0.9.5 as
  of 2026-09-21. **A repo that merges the reader and leaves the caret is the same bug as a repo
  that ships the guard nobody can install** — both halves have to move, and only one of them is in
  the diff you are reading.

  **Which makes the numbers in this bullet a dated reading, like the six in migration 9's.** They
  were re-quoted as current six weeks on and sent another agent to solve a problem that had
  dissolved. Keep the sentence, date the list, and get the current answer from the resolver.

- **Two plan items did not survive contact with the branch, in opposite directions.** A note to
  check a GoTrue nonce variable before removing it was stale — the repo had already deleted it, and
  the local checkout was 58 commits behind, which is the only reason the note looked live. The
  adapter the plan proposed adopting was already adopted. Re-read before you write the finding
  down, and re-read the REMOTE, because a stale checkout makes every version claim about the fleet
  wrong in the same direction.

## The locale gate (six adopters, one blink)

Every adopter with per-language addresses showed a reader the default language for about a
second on a bare address, then jumped to theirs.

- **A redirect decided in the entry runs after the page has painted.** The entry is a module
  script, so it is deferred: the browser parses and paints the prerendered default-language body
  first, then runs the redirect. Measured with headless Chromium in Portuguese, recording each
  document's first animation frame, its address and the text on it: one adopter's bare address
  showed a visible English frame before the fix, and none after. The fix is a classic,
  parser-blocking script at the very top of `<head>`, served as a file. `localeGateScript` builds
  it and `prePaintScript` delivers it, because a `script-src 'self'` policy drops an inline one
  with no error, and then the blink is simply back.
- **Moving the decision moved a duty onto the picker.** The gate reads a saved choice first, then
  the browser. The default language's link is a bare address, so a picker that saves nothing
  hands that address back to the browser: one adopter's footer made its default language
  impossible to pick for a reader whose browser preferred another.
- **Then the middle click, in every adopter at once.** Nine pickers saved the choice in
  `onClick`. A middle click opens the link in a new tab and fires `auxclick`, never `click`, so
  the new tab's gate reads the old choice and sends the reader back. Six of the nine are real
  links a mouse can reach, on four sites; the other three render a `<select>` for sighted readers
  with `sr-only` anchors beside it for crawlers, which no mouse can middle-click. Two comments in
  the fleet promised a reader could middle-click, above handlers that ignored it. The README
  states the rule now, because no adopter can import it: a picker's markup is product code.
- **A browser check that clicks at `load` measures the HTML, not the app.** The first live check
  after the middle-click fix still showed the bug on a site that had the fix deployed and in its
  bundle. The click had landed before hydration attached React's listeners. The control that had
  "reproduced" the bug on the unfixed sites had the same flaw, so it proved nothing either. Both
  were rerun two seconds after load: the three sites still unfixed bounced, and each held once its
  fix deployed. The first site's pre-fix state was never measured correctly. A check with no
  settle time can pass or fail for a reason that has nothing to do with the code under test,
  which is the other half of "a check needs a positive control".
- **The gate changed a behaviour nobody had written down.** One adopter's old redirect let any
  English tag anywhere in `navigator.languages` win, and matched `pt` and `pt-PT` to nothing.
  The gate walks the reader's own order, exact tag first, then the base subtag. A migration that
  only asks "does it still redirect" would have called both the same.
- **And the kit's own detector had that same old behaviour.** `i18nInitOptions` handed i18next the
  browser's list, and i18next takes the first EXACT match anywhere in it before it tries a base
  subtag, so a reader on `[pt-PT, en]` got English. The gate on the bare address sends them to
  pt-BR, and the app inside then settled on English. It now settles each tag on its own before
  i18next sees the list. A fleet audit found it by running the real detector on three lists; the
  test does the same.

## How to migrate a repo — the check that is not optional

**Read the code you are deleting against the code replacing it, function by function. Its
tests are not enough.** A green suite after a migration means the donor's tests still pass. It
says nothing about the donor behaviour nobody wrote a test for, which is most of what this layer
does. So for every file being deleted: list what it does, and find each one here. What is
missing comes UP into the package before the delete lands — that is the whole point, and it is
how the other eleven repos get it.

**Every migration must be net-negative in lines — measured on the ADOPTION commits, in source.**
If the code that swaps an adopter's copy for this package grows, the cut line was drawn in the
wrong place and the fix belongs here, not in the adopter. But a migration also fixes the bugs it
finds and sometimes builds what it discovers is missing, and those commits can carry the whole
range positive with nothing wrong; tests that pin behaviour nobody had pinned do the same. So
split the number and say which part is which. What is never allowed is padding the diff to reach
a negative total — deleting tests, or leaving a bug alone, to make an arithmetic look right.
Migration 7 is the worked example: +125 over the range, −169 of source across its seven adoptions,
+102 of it tests in two files.

The tree is shared. Other agents work the same branch concurrently with uncommitted work you
cannot see — providerkit's fourth migration was started and backed out for exactly that. Commit
your own slice per file, by pathspec, and never touch a foreign dirty file.
