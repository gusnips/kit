Entry point for AI agents working on this repo.

# frontkit

**The layer under a Vite + React SPA.** The build rig, the fetch client, the auth store, the
guards, the tokens — everything twelve products wrote twelve times. Deliberately **not** a
component library: no styled Button, no brand, no illustrations. Those are where a product
lives and they stay in the app.

MIT · open source · npm scope `@gusnips`

## Why it exists

Extracted from twelve private frontends in `~/dev` that had each independently grown the same
layer — roughly **48,000 lines of plumbing across nine independent repos**, on one stack:
Vite 8 + React 19 + react-router-dom 7 + Tailwind 4 + zustand + TanStack Query + i18next,
Bun workspaces, `apps/{web,api,site}` + `packages/{ui,server,shared}`.

Six filenames exist in all twelve: `vite.config.ts`, `main.tsx`, `App.tsx`,
`entry-server.tsx`, `prerender.ts`, `publicPages.ts`. Nine have `authStore.ts`. Ten have
`Button.tsx` and ten define their own `cn()`.

They are **not copies**, and that is the entire point. `prerender.ts` runs 104–424 lines with
1–82% line overlap; `ErrorState.tsx` across seven repos overlaps 9–37%. The same problem was
solved from scratch a dozen times, and **each copy knows something the others do not.**
Reading them against each other is what this package is; the merge is worth more than the
dedup. Three examples from the first audit alone:

- Three repos independently invented `PRERENDERED_ROUTE_ATTR = "data-prerendered-route"` —
  same name, same string, same hydrate-or-mount decision, same explaining comment.
- Three repos independently invented single-flight token refresh, because GoTrue rotates the
  refresh token and six parallel queries would each invalidate the winner.
- Three repos wrote three different react-query retry rules, and **each one is right about
  something the other two get wrong** (see invariant 8).

The source repos are private and are not named here; nothing about the package depends on
knowing which they were. **That covers every file, code comment and commit message, because this
repo is public.** Say "the first adopter", "a donor" or "the second migration". Names already got
into the history once, and the only fix was rewriting all of it before the first push.

## Layout

```
frontkit/               ← repo root (this folder), git root
├── tokens/             ← @gusnips/tokens: one Tailwind 4 @theme file. Zero deps.
├── http/               ← @gusnips/http: the envelope; /retry, when to try again. Zero deps, no framework.
├── locale/             ← @gusnips/locale: where a language lives in a URL; /time, what day it is; /money, what a language pays in. A leaf.
├── br/                 ← @gusnips/br: CPF, CNPJ, Brazilian phones, CEP. Zero deps.
├── cnpj/               ← @gusnips/cnpj: a company by its CNPJ, from a registry or four public APIs. Needs br.
├── react/              ← @gusnips/react: the headless runtime. One required peer: react.
│   └── src/ui/         ← the seven Base UI wrappers, behind a subpath (see below)
├── vite/               ← @gusnips/vite: the build rig. The ONLY package allowed node:fs.
├── scripts/            ← check-purity.ts, check-exports.ts and check-release.ts, the guards
└── AGENTS.md           ← this file
```

**Subpaths, and the rule that decides them.** Anything needing a peer the main entry does not
already require lives behind one, so an adopter installs a dependency only by importing the thing
that uses it — `@gusnips/react/ui` (`@base-ui/react`), `/store` (`zustand`), `/guards`
(`react-router-dom`), `/hydrate` (`react-dom`), `/contract` (nothing), `/theme` (React only, so
the Vite plugin that serializes it loads nothing else), `/oauth` (`@tanstack/react-query`, the
first subpath to import it at runtime), `@gusnips/vite/preset`, `/render` and `/theme` (React). See invariant 15; `bun run exports` is what holds the line.

`@gusnips/locale/time` is a subpath no peer forced. What day it is in a zone has the same
profile as the rest of that package — servers, browsers and Workers, `Intl` only — and `formatDayKey`
takes a locale, so a sixth leaf would be one more version to keep in step and save no one an
install. It stays off the main entry because that entry is about addresses: a server reading
`asLocale` should not page through date arithmetic to find it.

`@gusnips/vite/i18n` is the second, for the same reason. The catalog check needs only `node:fs`,
which the main entry already uses, but it runs in CI and never in a build. A prerender script
reading `bakeHead` should not load it.

`@gusnips/vite/contrast` is the fourth subpath no peer forced (the third, `@gusnips/http/retry`,
is below). It shells the Tailwind CLI over the adopter's own entry, so `tailwindcss` and
`@tailwindcss/cli` are optional peers reachable only from there.

`@gusnips/http/retry` is the third. Invariant 8's rule moved there from `@gusnips/react` so an SDK
with no React in it can follow it, and every server imports the main entry for the envelope and
never retries anything. `@gusnips/react` re-exports `retryAfterSecs` from it and keeps
`shouldRetry(error, codes, maxWait)` as the react-query binding.

`@gusnips/locale/money` is the fifth, and no peer forced it either: which currency a language pays
in, which one a customer is locked to, and how an amount and a currency read in a list are one rule
that every product selling in more than one currency would otherwise write again, and a mistake in
it charges somebody the wrong amount. It holds no price. It also holds no picker. A currency
selector was built first, on the Base UI `Select`, and the first adopter had no Base UI and its own
native select field: of the eight products that sell, three do not use Base UI, and every one has a
select of its own. So the rule is shared (`currencyLabel`) and the control stays the product's.

`react` is the only peer `@gusnips/react`'s main entry requires, and that is deliberate rather
than incidental: it is what makes the package importable from **React Native**, which has no
react-dom to give. See migration 2.

**Seven packages, split by dependency profile.** That split is not taste; it is what each
consumer can afford to install:

- `tokens/` is imported by the Astro marketing sites too, so it cannot contain JavaScript.
- `http/` is imported by `apps/api`, so it cannot contain React. A server depending on a
  package named "react" is a smell even when it costs nothing at runtime.
- `locale/` is imported by `apps/api` for the same reason, and it is where the fifth package
  came from rather than a `@gusnips/react/locale` subpath. Measured across the six repos that
  have this module: every `apps/api` imports `asLocale` and the locale list, and **not one**
  imports a path helper. The list is product data that stays home either way, so the server's
  whole use of the shared half is one narrowing function — and putting that behind the react
  package's name would put react in six servers' dependency graphs to get it.
- `br/` is imported by `apps/api`, by web forms and by a React Native screen, so it has the
  profile of `http/` and `locale/`: no framework, no platform, no dependency. It is its own package
  rather than a part of either because a country's documents are neither the envelope nor a
  language — an English UI in Brazil still validates a CNPJ. Six adopters had written it, in three
  independent lineages, and none accepted the alphanumeric CNPJ. The CEP lookup is its one network
  call, so it is a subpath (`@gusnips/br/lookup`) and the main entry never touches `fetch`.
- `cnpj/` asks the network for a company, so it has `br/`'s profile plus `fetch`. It is a package
  and not a second `br/` subpath because its mappings follow four public services outside our
  control: one of them changing a field is a release, and that release should not move the version
  every server imports for `isValidCnpj`.
- `react/` runs in a browser AND inside a prerender, so it cannot contain `node:*`.
- `vite/` needs `node:fs`. Having somewhere for that to live is what lets the other three be
  strict.

Dependency edges run one way: `vite/ → react/ → http/`, and `cnpj/ → br/`. Never the reverse. In
particular `PRERENDERED_ROUTE_ATTR` lives in `react/`, not `vite/`, because a **browser entry** reads
it, and putting it in the build-time package would drag `node:` into the client bundle.

`locale/` is a **leaf**: nothing in frontkit imports it, deliberately. A package that depends on
it would pin it at an exact version at pack time, which is the hazard the `vite → react` pin
already costs us a paired bump for; a leaf has no version anyone else can get wrong. That is also
why `i18nInitOptions` does not read `LOCALE_QUERY_PARAM` itself — the adopter passes it, one line,
and the writer and the reader of the language still cannot drift.

`br/` was a leaf too, until `cnpj/`. cnpj asks for it as `workspace:^`, which packs as a caret on
br's current version rather than an exact pin, so an adopter on a newer br in the same minor still
gets one copy. Two copies are possible across a minor, because a caret on a 0.x does not cross one,
and they cost bytes and nothing else: br is pure functions with no module state, and cnpj
re-exports none of its classes, so no `instanceof` can see two of them. Release cnpj after a br
minor anyway, to keep it at one.

Folder names state their ROLE, not an npm scope — the same rule as providerkit's `core/`.

## Commands

```bash
bun install                  # workspace root

bun run check                # lint → typecheck → purity → test, every package
bun run purity               # the platform guard on its own
bun run release:check        # what the REGISTRY would get — run before every publish
bun run build
bun run format              # prettier --write — run before pushing, CI fails on unformatted files
```

Per package: `cd react && bun run test`, etc.

## Naming and publishing — decided

- **Scope `@gusnips`**, already owned (`@gusnips/asaas` lives there). Not `@providerkit`, even
  though that org is free: "providerkit" means LLM-provider abstraction, so `@providerkit/tokens`
  would inherit the wrong noun. providerkit stays narrow and keeps `@providerkit/react` for real
  React bindings to its agent loop.
- Scoped packages publish restricted by default; `publishConfig.access` is `public` on every
  package so a release cannot silently go private.
- **Adopters resolve from the registry** — never `link:` or `file:`. providerkit's lesson: a
  `file:` dependency resolves on exactly one machine, and it drags the package's own
  devDependencies into the adopter's lockfile.
- **Release with `bun publish`, never `npm publish`.** `@gusnips/vite` depends on `@gusnips/react`
  at `workspace:*`, which npm cannot resolve — something has to rewrite it to a real version at pack
  time, and both ways of getting that wrong have already shipped. `npm publish` does not rewrite it
  at all, so `@gusnips/vite@0.4.0` went out with the literal string `workspace:*` and cannot be
  installed. `bun publish` rewrites it **from `bun.lock`, not from the sibling's package.json** —
  which is why `@gusnips/vite@0.3.0` pins `@gusnips/react@0.2.0` and gives an adopter a second,
  older copy of react nested under vite. Neither is visible from the source tree, where the
  workspace link makes every version correct.
- **Bumping a version does not update the lockfile. Delete `bun.lock` and re-install.** This is the
  sharp edge under the bullet above, and "run `bun install` first" — what this file said before —
  does not do it. bun rewrites a workspace's recorded `version` only when that workspace's
  _dependencies_ change; a version-only bump changes nothing bun looks at, so `bun install`,
  `bun install --force` and `bun install --lockfile-only` all report success and leave the old
  number in place. `bun publish` then pins the sibling to it. The only thing that reconciles the two
  is `rm bun.lock && bun install`, which also floats every unpinned dependency — do it deliberately,
  at release time, and run `bun run check` after.
- **`bun run release:check` packs each package and reads the manifest that comes out.** It is the
  only thing here that looks at what the registry will actually receive, and the only reason the
  bug above is a caught error rather than a broken tarball.
- **Publish in dependency order** (`tokens`, `http`, `locale`, `br`, `cnpj`, `react`, `vite`), and bump `vite` whenever
  `react` ships, because the pin inside it changed even when none of its own code did.
- **And the adopter's half of that pin: the two carets move together, or the install grows a second
  copy of `react`.** That exact pin inside `vite` is reachable through the ADOPTER's `vite` caret,
  so a repo whose `react` caret sits a minor behind gets both. Measured by really installing
  `{"@gusnips/react": "^0.8.0", "@gusnips/vite": "^0.8.2"}` — two repos carried exactly that when
  this was written. **This sentence then said no repo did any more, and that was false.**
  Re-measured 2026-09-21 against every `package.json` in the fleet: **six still declared
  `@gusnips/react` at `^0.8.0`**, so none of them could receive anything released into 0.9 at all.
  The correction that replaced it was written the same afternoon as the claim it corrected, and
  was wrong in the opposite direction — first the carets were read as older than they were, then
  as newer. **Both readings came from quoting a list instead of installing one.**

  **Then a THIRD count in this same sentence was false, two hours later, and it was the correction
  itself.** It closed "twelve now sit on `{^0.9.5, ^0.8.9}` and the thirteenth has no `vite`".
  Re-measured against a freshly fetched `origin/main`, per `package.json`, on the evening of
  2026-09-21: **two adopters were on older matched pairs** — `{^0.9.2, ^0.8.6}` and
  `{^0.9.3, ^0.8.7}` — both correct, both behind, and neither counted. Three wrong numbers in one
  sentence in one afternoon is not three mistakes; it is one, and the mistake is **printing a
  count here at all.** A number in this file is a reading with no timestamp attached to it, and
  the fleet moves hourly. So the sentence no longer carries one: the pairs are a thing the reader
  MEASURES — `git show origin/main:<path>` for every `package.json`, then `bun why`, per repo —
  and this file's job is the rule and the method, never the tally. The install below is still the
  evidence — which
  resolves `@gusnips/react` to **0.8.1 and 0.9.2 at once**, because `^0.8.2` floats vite to 0.8.6
  whose pin is `0.9.2` and a caret on a 0.x does not cross a minor. `{"^0.9.0", "^0.8.4"}` installs
  one copy, also measured. Nothing warns: `bun install` is silent, `release:check` reads what the
  REGISTRY gets and not what an adopter assembles, and the two `PRERENDERED_ROUTE_ATTR`s happened to
  be the same string, so even the failure invariant 2 describes stays quiet. The rule is that the
  pair is one decision: bump `react` and `vite` in the same commit, in the adopter too, never only
  the one whose changelog you were reading.

  **Two things about MEASURING it, both learned by getting them wrong an hour apart.** This bullet
  first said one repo, and the count was wrong because the scan read each repo's ROOT manifest only —
  which answers for the repos that keep a dependency catalog and silently skips every repo that
  declares the same dependency inside its workspaces. Three of twelve did, and one of those three was
  the second offender. A fleet-wide dependency question is asked of **every** `package.json`, never
  the root one.

  And this bullet first offered `find node_modules -path '*@gusnips/react/package.json'` as the
  one-line check. Under bun's isolated linker that is wrong in the direction that invents a problem:
  it walks `node_modules/.bun`, the content store, which keeps every version ever installed in that
  tree — so a range you have already corrected still reports two copies. Ask the resolver instead:
  `bun why @gusnips/react` prints one heading per RESOLVED version, and one heading is the whole
  test. Watched misfiring on a real tree before the replacement was believed, which is the only
  evidence a check ever has.

  **And the split does not need two repos — one repo can do it to itself in a single commit.** An
  adopter with no dependency catalog names the range in every workspace that uses it, and a bump that
  moves some of them is a bump that CREATES the second copy rather than finding one. Measured
  2026-09-21: four workspaces in one adopter declare `@gusnips/react`, the commit moved three, and
  `bun why` then answered **0.9.5 and 0.9.1 at once** — a caret on a 0.x does not go backwards, so
  the two ranges cannot meet. `bun install` said nothing. That is the same sentence above reaching
  the case it did not name, and it also explains why the other adopters are safe: **a `catalog:`
  entry is a pointer, not a range, so a catalog repo has exactly one range to get wrong.** Swept
  across the fleet against `origin/main`, the catalog repos each declare one literal range; the one
  without a catalog is the one that split. The immunity is the catalog, so a repo that does not keep
  one gets the per-workspace check by hand.

  **`@gusnips/http` rides in that pin too, and so does every package that asks for it.** `react`
  pins `http` exactly at pack time, so moving `react` moves `http` for the adopter. A package of
  ours that names an older `http` in a caret (`@gusnips/sdkgen` asked for `^0.1.5`) then leaves the
  adopter with two copies as soon as `react` passes a minor. Measured at `http` 0.2.0, which renamed
  `ApiError` and `shouldRetry`: `bun why @gusnips/http` printed 0.1.6 and 0.2.0 in an adopter that
  had only bumped `react`. So a breaking change in `http` is a release of `react`, `vite`, `server`
  and `sdkgen` together, and an adopter moves all four, then regenerates its SDK, in one commit.

## What must NOT be shared

This rule is what keeps the package alive; violating it is how design systems die. Each of
these was checked against the code, not assumed.

- **`packages/ui/src/brand/` stays in each product.** One product has a colibri, one has a
  mascot named Jack, one has a Scene set. That is the product, not the plumbing.
- **Styled `Button.tsx` stays put.** The two best copies are 104 lines (cva, 11 variants, 10
  sizes, a loading spinner) and 60 lines (4 variants, 3 sizes, no cva, and deliberately _no_
  `focus-visible:` styles because its one focus ring lives in the theme). They overlap on the
  idea and nothing else. A shared styled Button satisfying eight brands grows variant props
  forever. Share behavior, skin per product. What a busy button needs is shared in two small
  pieces that carry no skin: `useHeldPending` and `BusyRing` in `@gusnips/react`, and the ring's
  CSS in `@gusnips/tokens/busy-ring.css`. The Button that calls them stays in the product.
- **`EmptyState` / `ErrorState` ship as a contract, not a component.** They share a prop shape
  and one class string; the visual is a tinted icon badge, a branded Scene, or a mascot board.
  What ships is `EmptyStateProps` / `ErrorStateProps` — the _type_ is what enforces "never dead
  end the user" — plus the error→copy machinery behind them. The rendering stays home.
- **App scaffolding** (`main.tsx`, `App.tsx`, folder layout) is a template copied once, not a
  dependency.
- **Colours.** `tokens/` defines the token NAMES and the dark-mode MECHANISM; each product fills
  the values.
- **Error code lists.** `http/` ships the envelope generic over a product's own code union. The
  codes themselves are that API's vocabulary.

## Invariants — do not regress these

Each cost someone a production incident, or is one lazy route away from costing one. The tests
pin them; if one fails, a lesson is being un-learned.

1. **Prerender with `react-dom/static`, never `renderToString`.** With `lazy()` routes behind a
   `<Suspense>`, `renderToString` renders the **fallback** — a loading screen written into every
   file, passing every gate that only asks whether the root has children. Two more halves of the
   same lesson, from two other repos: `renderToString` also answers `""` for a basename/location
   mismatch with no error and no warning (so **assert non-empty output per route**), and React 19
   hoists in-tree `<title>`/`<meta>`/`<link>` to the FRONT of the server stream — which lands
   inside the body when you are filling one `<div>` rather than assembling a document. Strip
   them, and rethrow `onError` so a render failure fails the build.

   **And it does not always render the fallback — sometimes it renders its own ERROR.** The eighth
   migration found a live, indexed reference page carrying React's "The server used renderToString
   which does not support Suspense" text, a stack trace, and five copies of an absolute path from
   the machine that built it. Nothing in a browser shows it: the bundle replaces the body on load,
   so the only readers who ever saw it are the ones who do not run JavaScript — which is every
   crawler the prerender exists for. It was in ONE language, and that half nobody would guess: the
   first render suspends and bails, but it also resolves the `lazy()` promise, so the next locale in
   the same loop rendered the real component. One loop, two language versions of one address, one of
   them a stack trace. Every cheap check passes it — the error text makes the file BIGGER, so a size
   floor reads it as a full page. `assertRendered` refuses that signature now, because the adopters
   still on `renderToString` are the ones who need it and they are exactly the ones not reading this.

   One cost comes with it, and it belongs beside the rule rather than in a bug report: under bun,
   importing that renderer holds the event loop open, so a prerender script that has written every
   file and printed its summary **will not exit on its own**. It ends with `process.exit(0)`.
   Measured by elimination, with no app code loaded: `react-dom/server` exits,
   `react-dom/static.browser` does not, node exits either way, and
   `process.getActiveResourcesInfo()` reports nothing — so the only symptom is a CI job that does
   all of its work and then runs to its timeout. A library must not call `exit` on its host, which
   is why this is written down in three places instead of fixed in one.

2. **A prerendered file names its own route**, and the entry hydrates only on a match.
   "Does the root have children" is the wrong question and getting it wrong is silent: a static
   host answers every address it does not publish with the nearest `404.html`, which has the
   not-found page rendered INTO it. Hydrating that is React reconciling two different pages — it
   recovers by throwing the tree away and logging, which is a page that works and a bug nobody
   sees.

   **And nothing random or clock-dependent may initialize prerendered state.** That is the same
   failure arriving from inside the tree instead of from the address. A front page whose hero did
   `useState(pickRandomIndex)` ran that initializer twice — once in the build, baking one variant
   into the file a crawler reads, and once in the browser, drawing another. One render, two
   independent draws, and React settles it by discarding the prerendered tree and redrawing: it
   looks perfect, and it costs the whole point of prerendering on the page that gets the most
   traffic. The tell is the only visible symptom and it is worth knowing on its own — **every build
   emits a different file**, so no byte-diff can separate a real change from a coin flip, and the
   verification a migration depends on quietly stops working. Three repos shipped it, and the
   third is the shape a search for `useState(` misses: suggestion chips sampled inside a `useMemo`,
   so search for the draw itself (`Math.random`), not for where it lands. Pick a constant, seed it,
   or move the draw into an effect that runs after mount — and for anything a reader aims at, take
   the constant, because the effect's swap lands just as the control becomes clickable.

3. **A failed refresh is not a dead session.** Only auth actually answering "no" signs anyone
   out; a network failure falls through and the request is retried. Collapsing the two means a
   Wi-Fi blip logs the user out mid-load. And a sign-out needs a fail-safe timer: awaiting
   `signOut()` before redirecting covers a rejection, not a hang, and a hang leaves someone
   signed out in name only — every request 401ing, nothing left that could redirect it.

   **And a sign-out that cannot reach auth leaves the person signed in.** Measured on nine auth-js
   versions from 2.106.2 to 2.117.2: with an expired access token and no network, `signOut()`
   resolves `{ error }` and keeps the stored session at every one of them, and before 2.110.2 it
   does the same when only `/logout` goes unanswered. `scope: "local"` calls `/logout` too. A
   reload reads the session back, so a screen showing "signed out" over it is wrong, and on a
   shared computer the next person is signed in. `signOutEvenOffline` removes it from storage
   within the API client's 3 s sign-out deadline, then lets auth-js's own local sign-out send
   `SIGNED_OUT`.

   **And a sign-out ends this device's session, never every one.** auth-js's `signOut()` defaults to
   `scope: "global"`, which revokes every refresh token the person has. Through react 0.9.27 both
   the helper and the session adapter called it bare, so signing out anywhere signed the person
   out everywhere, and every tab left open on another device failed its next refresh with
   "Invalid Refresh Token: Refresh Token Not Found". Every sign-out here passes
   `scope: "local"`. Ending the other sessions is its own action, `signOutOtherDevices`
   (`scope: "others"`), which leaves this device signed in so a failure can be retried.

   **A 5xx is auth failing, not auth answering, and the vendor's own predicate must not be
   trusted to say so.** `isAuthRetryableFetchError` reads a list its library owns and has already
   changed — 502, 503 and 504 at auth-js 2.91; those plus the 52x family and still **no 500** at
   2.106; 500 through 530 at 2.108 — so a copy leaning on it alone is correct at whichever
   version happens to be installed, which is not the same as being correct. Nor is "newer is
   wider" a fact to lean on: a fleet installs several versions at once, so the version is read
   off the tree the app builds against, per repo, and never off a changelog. 2.106 is the line
   where the status clause is the only thing catching GoTrue's own 500. Which repos resolve it is
   a question for `bun why @supabase/auth-js` in each one, not for this file.

   **And it is a LIST, not a range, so it has holes at every version — drift is not the only
   argument.** At 2.112.4 it reads 500-504 and 520-530: nothing covers 505 through 519, nothing
   covers 531 up. A 507 or a 599 with a JSON body arrives as a plain `AuthApiError`, and the
   vendor's predicate answers false for it at every version ever shipped. (With a body that is
   not JSON, which is what a proxy usually sends, it arrives as an `AuthUnknownError` with no
   status at all. `isAuthOutage` answers false for that on purpose, because nothing separates it
   from a malformed 400; its test says why. This sentence said "a proxy" without the body until
   2026-09-26, and an adopter read it as a kit bug.)
   That matters because the drift argument invites exactly one reply — "then pin a recent SDK and
   drop the redundant clause" — and this closes it. `isAuthRetryableFetchError` is a NAME check;
   the statuses that earn the name are chosen where auth-js CONSTRUCTS the error, which is the
   file to read when this needs measuring again, not the predicate.

   **The copy of this rule most likely to be wrong is a comment naming a version.** Writing the
   number down is what makes the clause's reason checkable, and it is also what makes it rot —
   and it does not rot alone, it gets COPIED, because such a sentence reads like a fact about the
   SDK rather than a fact about one tree. Eleven repos carry an auth-js version in the file that
   decides this, and **two were false the same way**: a 2.106-shaped answer carried into a tree on
   **2.108.2** and into one on **2.116.0**, each giving the same reason for the status clause —
   "a plain 500 is on no version's list" — which is true at 2.106 and false in both trees it sat
   in. Both were written the same day as this rule. In both the code was right, and the
   justification was the part a future reader would have acted on. So: name a version only where
   it is load-bearing, say how to check it (`bun why`, which prints one heading per RESOLVED
   version), and measure it in the tree the comment is going into — not the one you measured last.

   **The sweep that finds this is a FILE gate, not a line grep** — and this paragraph first said
   ten repos and one false comment, because it was a line grep. Both false comments name the SDK
   one line above the number, so two passes asking for "auth-js" and a version on the SAME line
   reported them clean. Ask it per file instead: for every file that touches the retryable
   predicate, list each version literal in it and print `bun why` beside it. A claim about the
   fleet is worth exactly the sweep that produced it.

   **The third false one named no version at all, and that is the harder half.** An adopter's
   test said a plain 500 "is on no version of the SDK's retryable list, so it arrives as an
   ordinary AuthApiError" — false in its own tree, where 500 IS on the list and arrives as an
   `AuthRetryableFetchError`. So the test was building the wrong shape to stand for the thing it
   was about, and its assertion held for a reason the sentence beside it got wrong. **"No version"
   is a version claim**, and it walks straight through the gate above, which looks for a version
   LITERAL. The gate finds the claims that rot; it cannot find the ones that were never
   measurable in the first place, and those are the ones stated most confidently.

   What it costs when the clause is missing: four backends in the fleet answered **401 to their
   own auth provider's 500**, and every client reads a 401 as a dead session, so one bad minute
   at auth signed out everybody signed in.

   The shape is `isAuthRetryableFetchError(e) || (e.status ?? 0) >= 500`, and it belongs at
   every site that decides whether a session is over — the adapter's `reachedAuth`, the API
   door, and a callback that chooses between "retry" and "that link is spent".

   **`@gusnips/react/supabase` exports it as `isAuthOutage`**, because five adopters had written
   those same four tokens by hand and a sixth was about to — migration 2's rule, arriving for the
   third time. Only the client half: several of the copies live in an `apps/api` or a
   `packages/server`, and a server must not depend on a package named react. That half belongs to
   the server kit, which already re-exports the vendor's predicate and needs the clause beside it.

   **And exporting it moved the hazard: `isAuthOutage(null)` answered true.** Inside the package
   that was never reachable — `reachedAuth` filters with `error === null ||` before it asks — so a
   green suite kept it through the release. But `null` is the SUCCESS value of every supabase-js
   auth call, and the whole point of exporting the test is that adopters write
   `if (isAuthOutage(error))` around a `{ data, error }` result. That put "auth is down" on top of
   every success. The tell was the same one that produced the export: an adopter had already
   written the guard at its own call site (`!(error !== null && isAuthOutage(error))`), which is
   migration 2's rule pointing at a function that exists because of migration 2's rule. Fixed in
   0.9.5. **A predicate that is only ever fed a caught error has a different contract from one
   anybody may call**, and publishing it is what changes which contract it is under.

   The sibling reading is worth keeping beside it, because the two copies of this predicate in the
   fleet answer the OPPOSITE way for the same input and both are right: in a browser, a throw that
   is not an `AuthError` is a fetch `TypeError` or a CORS refusal — not auth answering, so `true`.
   On a server the same `catch` wraps a database lookup, where a driver error is not an auth
   outage, so `false`. One name, two call sites, two correct answers; do not "reconcile" them.

   **The same clause is wrong one step later, at the sentence.** "Check your connection" is true
   of a request that never landed and false of a 5xx, which is ours. auth-js marks "nothing came
   back", and only that, with **status 0** — so the copy splits on the status and never on the
   class, which is the one test that stays right as the vendor's list moves. Four repos have both
   call sites in one file, so the two are easy to conflate.

   And this said "let the 5xx fall to the generic line", which is the floor rather than the
   answer: "something went wrong" tells a reader nothing to do next, and what a 5xx out of auth
   needs is its own sentence — our side failed, wait a moment, the button beside this works.
   Applying the rule across the fleet is what turned that up; the generic line is where a 5xx
   must not stay, not where it belongs.

4. **A failed query is not an answer.** `!me?.isStaff` reads a 500 as "not staff", so an
   operator arriving while `/auth/me` is down is told the page does not exist — the wrong cause,
   no retry, no request id to quote. A guard decides between waiting, failing and answering; only
   a real `false` reaches the refusal.

   **And a failed refresh is not a failed page.** `isError` is also true when a background
   refetch fails over data already on screen, so `isError ? <panel> : <data>` swaps a loaded
   screen for a failure over one blip. Four adopters' boundaries had learned it and carried the
   same comment; the fifth, and inline ternaries by the hundred, had not. `queryView` is the
   shared answer, and its test drives a real observer, so it pins react-query's definitions rather
   than this package's reading of them.

5. **Every address the app advertises answers 200 — on Cloudflare Pages, that means flat page
   files** (`pricing.html`), not `pricing/index.html`. Cloudflare Pages serves the directory form
   at `/pricing/` and answers `/pricing` with a 308 — so every address the app advertises in its
   canonical and its sitemap would be a redirect rather than a page. The file form is the host's
   call: Firebase Hosting redirects the other way by default and serves the directory form as
   itself with `trailingSlash: false`. A redirect costs twice, once for the crawler and once in the
   entry, where the address bar stops matching the route the file names (invariant 2).

   **And an app advertises addresses in its own LINKS, not only in its head.** One adopter's
   canonicals and both its sitemaps were already right on this rule, and every page still carried
   a hand-written link to the bare `/docs` — 16 of them, written that way because it reads tidier
   than `/docs/`, on the likeliest first click into a reference that lives under a path prefix.
   The host answers it with a 308. A sitemap is walked once by a crawler; a link in the body is
   what a reader presses, so the rule covers both and the check is `curl -I` on the link, not a
   re-read of the canonical. This is also why `localeUrl` returns `origin + "/"` for the default
   locale's root rather than the bare origin: the caller passed `"/"` as the path, so dropping it
   is the helper discarding an argument to look tidier — the same instinct, one layer down. The
   planned finding here was a decline, on the reasoning that the helper would break a deliberate
   bare form; the host said the bare form had always been a redirect. **Measure the blocker
   before you design around it.**

6. **`og:locale` is not optional on a non-English page.** Absent, the Open Graph spec does not
   default it to "unknown" — it defaults to `en_US`, so a Portuguese page with a Portuguese
   `og:title` tells every share crawler the card is English.
7. **`isLoading` starts false where there is no window.** A session bootstrap can only be in
   flight in a browser. `true` during a build is a wait that never ends: it shipped a spinner as
   the indexable body of a page whose whole purpose was to be found.
8. **Never retry what waiting cannot fix, and when it says how long, believe it.** 402 and a
   durable 429 (`QUOTA_EXCEEDED`, `PAYMENT_REQUIRED`) clear by buying, not by waiting; retrying
   them burns another request against the limiter and says the same thing three times. Retry 408,
   425, a transient 429, 5xx, and no-response-at-all — nothing else.

   **The rule lives in `@gusnips/http/retry`, because five SDKs each wrote their own and each
   missed part of it.** None retried a 408, none read an explicit `retryAfterSecs: null`, three read
   the body's wait before the header, and the one that sent an idempotency key retried writes that
   had none. The rule reads an error by its fields, never its class, so an SDK's own error type
   works unchanged. `@gusnips/react` hands it only its own `ApiError` and passes anything else as
   "no answer", because the describer reads a vendor's error that way too, and the button and the
   retry must not disagree. 425 joined the list with the move: "too early" is a server declining
   to run a request sent in a TLS handshake's early data, so like 408 and 429 it says the request
   did not run.

   **Measured on the server side, where these are raised: of 13 raises of a 402 across five
   backends, none states a wait.** So the rule is not only a client-side policy — it is what every
   raiser in the fleet does today. Written that way on purpose: "no 402 in the fleet states a wait,
   in 13 raises" stays true forever, where "a 402 never states a wait" is a claim nobody measured
   and a card retry window or a transfer clearing overnight would contradict. The day an exception
   turns up it should read as a finding, not as this file being wrong — and the code already allows
   it, because the wait is available at every status.

   The number came out of building the same rule for the server
   kit, by counting raises rather than by arguing; and the count is worth more than its answer,
   because the same method answered three statuses three different ways. A 429 was the opposite
   (**34 of 40 raises already state a wait**, which is why a required argument was cheap there),
   and a 5xx was a third thing again (**16 of 94** — most of them "the database is unreachable",
   with no wait to state, so the wait stayed a capability and never became an obligation). One
   method, three answers, is what makes it evidence rather than a prior with a number stapled to
   it. Do not read the 429's 34-of-40 as agreeing with this rule: it counts a different thing,
   and quoting it here would suggest a 429 usually knows its wait, which is true, and that waiting
   therefore fixes it, which is the mistake the rule exists to stop.

   **And one axis this rule has never had: idempotency governs retry, not only transience.** A POST
   that failed with no answer may have succeeded, so retrying it duplicates; a GET cannot. One
   backend in the fleet writes it as `attempts: init.method === "POST" ? 1 : 3` and is the only
   copy anywhere that does. Everything above reasons about whether WAITING can help, which is the
   wrong question for a write: a transient 5xx on a charge is exactly the case this rule currently
   tells you to retry, and exactly the case where a retry can bill someone twice. Unless a request
   carries an idempotency key the server honours, a non-idempotent method gets one attempt.
   `@gusnips/http/retry` makes that a required argument, `repeatable`, with no default: `false`
   retries only 408, 425 and 429, the answers that say nothing ran. The react binding passes
   `true`, because a query is a read and `queryDefaults` never retries a mutation.

   The second half arrived with the second migration: a refusal that states its own expiry has already answered the question, so a
   short wait is WAITED OUT (`retryDelay` takes the stated seconds over the backoff) and a long
   one is an answer (`shouldRetry` refuses past `maxRetryWaitSecs`, default 10s). Without it a
   per-minute limiter answering `Retry-After: 60` got retried at 1s and 2s — two more requests
   that could not succeed, charged against the same limiter, and three seconds of spinner before
   the screen said anything. **Read the wait from the HEADER first**: it is where HTTP puts it,
   and the package looked only in `details.retryAfterSecs` — one donor's body convention — so for
   every API that follows the spec, the one refusal that states its expiry read as silent.

   **And a reading that came from the other end of the fleet rather than from a donor: a refusal
   can state that waiting never helps AT ALL.** For a limit no amount of time clears — a
   concurrency slot that frees when somebody else's job ends, a cap on live objects that clears
   by archiving one — the server kit answers with an explicit body `retryAfterSecs` of `null`,
   and deliberately no header, because a `Retry-After` stating no time is worse than none. Its own words for why
   that is a value and not an omission: **"an omission is invisible in a diff; a `null` is a
   claim somebody has to read."** This package could not read it. `retryAfterSecs` answered
   `null` for "said nothing" and for "said never" alike, so `shouldRetry` fell through to the
   status and retried a 429 — and a durable 503 — that the server had explicitly said would never
   clear, while an adopter kept a `durableLimitCodes` entry for that one refusal, which is the
   hand-maintained list the server's `null` exists to delete. **Two halves of one fleet shipped
   one value with two readings, and each half is right about its own question.** So the fix is a
   second, narrow predicate rather than a wider return type: the countdown UIs reading
   `retryAfterSecs` want `null` for both cases and are correct to. Read the two halves of a fleet
   against each other the way two donors get read — a client that normalizes an explicit value
   into an absent one is where a server's deliberate claim disappears.

9. **A wrapper forwards its rest props.** A closed prop list removes `name`, `required`, `form`
   and `data-*` from a form control. Four wrappers in the donor repo did exactly this: they did
   not add form integration, they removed it.
10. **No Node built-ins in `tokens/`, `http/` or `react/`.** `bun run purity` is the guard, and
    tsc cannot replace it — a root-level `@types/node` is visible to every workspace, so a stray
    `node:fs` import typechecks fine and breaks a browser bundle. Nor can any grep catch the
    sibling failure: a **browser global read at module scope** inside `react/` crashes a
    prerender rather than a bundle. That one is checked by eye at every extraction.
11. **Never `import.meta.dir`.** It is bun-only, and two donor scripts used it. Use
    `fileURLToPath(import.meta.url)`.
12. **A shell strips its canonical and its share URL, and names no card of its own.** Blanking
    is not stripping: an empty canonical is a claim about `""` and an empty `og:url` is a card
    pointing at the origin root. The image is the half that gets missed — one donor sets it
    before it branches on the shell, so its `404.html` advertises a card at
    `/og/__not-found__.png`, a file that has never existed. Every share of a missing address
    unfurls broken, and nothing in a browser shows it. **`bakeHead` strips the first two and
    cannot do the third**: it writes whatever `image` it is handed, and a shell with the brand
    card (`/og.png`, which exists) is correct, so an `image` beside `canonical: null` is not an
    error it can raise. The caller leaves `image` out. This invariant used to say the package
    "takes `og:image` with it", which the code never did.
13. **Sitemap `priority` arrives pre-formatted.** The two donors rank pages by different rules —
    one reads a field off its registry, the other gives the front door 1.0 and every guide 0.8
    flat, because ranking one guide above another would be a guess about a reader. A function
    that formats the number owns a decision belonging to whoever walks the registry.
14. **The template is also a destination.** `dist/index.html` is both the file every page is
    baked FROM and the home page's own output, so a second pass over a `dist/` already written
    reads a finished page as its blank and nests one render inside another. `vite build` empties
    `dist/` and normally makes this impossible; a restored build cache and a hand-run of the
    script both route around that. Refuse a template that already carries the prerendered-route
    attribute — and declare `dist-ssr/**` as a build output beside `dist/**`, or a cache replay
    restores written pages with no renderer beside them.
15. **A barrel imports what its lightest caller needs, and nothing else.** A re-export is a
    runtime import: `export { renderTree } from "./render.ts"` loads `react-dom/static.browser`
    for a script that only wanted `sitemapXml`. This has now happened three times, once in our
    own code — `hydrate.ts` sat in `react/`'s barrel beside the two prerender constants, so a
    build script reading a string constant pulled in the browser renderer. The fix each time was
    a subpath (`@gusnips/react/contract`, `@gusnips/vite/preset`, `@gusnips/vite/render`), and
    the payoff is that the peer can then be `optional`: an adopter who only generates a sitemap
    installs no React, and one on Radix installs no Base UI. Verify against the BUILT barrel's
    import graph, never the source — a type-only re-export looks identical in source and
    disappears at runtime, so reading `index.ts` answers a different question than the one that
    matters.

    **The mechanical form, which is what `bun run exports` checks: a peer marked `optional` must
    not be reachable from that package's `"."` entry.** Stated that way there is no judgement
    call about weight, and it caught the fourth instance the day it was written — `@gusnips/react`
    declared `zustand` and `react-router-dom` optional and imported both unconditionally from the
    one entry point every adopter loads. An optional peer the barrel imports anyway is not
    optional; it is a required peer whose error has been moved from install time, where a package
    manager explains it, to the adopter's first build, where a bundler blames one of OUR files for
    a package THEY never installed. `createAuthStore` and the guards moved to
    `@gusnips/react/store` and `@gusnips/react/guards`, and the main barrel now imports `react`
    and `@gusnips/http` and nothing else (`react-dom` left for `/hydrate` in the second
    migration). The three peers that stayed optional AND stayed in the barrel —
    `@tanstack/react-query`, `i18next`, `react-i18next` — are safe for the reason above: only
    their types are used, and types erase.

### …and six more for anything under `react/src/ui/`

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

### The token contract, measured

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

## What the migrations taught

### Migration 1 (−513 lines, 12 commits)

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

### Migration 2 (−735 lines, 14 commits)

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

### Migration 3 (−108 lines, 4 commits)

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

### Migration 4 (−233 lines, 3 commits)

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

### Migration 5 (−55 lines, 4 commits)

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

### Migration 6 (−282 lines, 5 commits)

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

### Migration 7 (14 commits: −169 source across the adoptions, +125 over the range)

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

### Migration 8 (−185 lines, 6 commits)

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

### Migration 9 (−81 lines, 3 commits)

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

  And the blocker that replaced it is one this file already names from the other end: atendime
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

### Migrations 10–12 (three sibling repos, −196 source each, one reading)

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

### Migration 13 (an audit of an already-migrated adopter)

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

### The locale gate (six adopters, one blink)

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

### How to migrate a repo — the check that is not optional

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

## House rules

- 2-space, printWidth 100, double quotes (matches `.prettierrc`).
- Source imports keep real `.ts` extensions; `rewriteRelativeImportExtensions` emits `.js`.
- No `as any` / `as unknown as T`. Fix the type.
- Comments explain **why**, especially the non-obvious production reason. That is most of the
  value being preserved here — a rule without its reason gets "simplified" away next quarter.
  When a comment in a donor file names a real incident, it comes across with the code.
- **Correcting a comment means grepping for its sentence, not fixing its line.** A comment good
  enough to be true and memorable gets quoted into this file, so the copy that misleads someone
  is usually the one you are not looking at. That already happened once here: `menu.tsx` said a
  Base UI production error arrives as "the bare number 31", the fix landed in `menu.tsx`, and the
  same sentence sat uncorrected in "What the migrations taught" — the document people read
  BEFORE the code.

  **And the copy a grep cannot reach is the one already sent to somebody.** A sentence in a
  reviewer's inbox, in a message to another agent, in a report someone is reading right now — no
  search finds it, only remembering you said it. That is not a completeness rule, it is an
  ORDERING one, and the ordering is what changes what you do first: **the in-flight copy is the
  only one with a deadline.** The code comment will still be wrong in ten minutes and still be
  fixable; the sentence somebody already has may already have been acted on. So the correction
  goes out before your own tree is clean, not after — which cuts against the instinct to wait
  until you have the fix in hand, because sending twice feels like admitting the mistake twice.
  Learned twice in one afternoon (2026-09-17), both times on our own text rather than a donor's:
  an overclaimed measurement was corrected in a code comment and a report, and the copy that
  mattered was the one inside a merge already in flight — it reached `main` and had to be
  cherry-picked out.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->


# serverkit

**The layer under a Bun or Node server on Postgres.** Three packages:

- **`@gusnips/migrate`** applies plain `.sql` files, writes TypeScript types from the live schema,
  and gives a stock Postgres in CI the roles and `auth` tables a Supabase database starts with.
- **`@gusnips/server`** is the answer edge: the error class, the wire envelope and its mask, the
  JSON logger, a `/hono` subpath with the middleware and the four success adapters, and a
  `/supabase` subpath holding the one decision a backend makes about Supabase Auth's answers, a
  `/pg` subpath holding the two a backend makes when it creates a connection pool, a `/redis`
  subpath holding the connection every backend on this stack opens for BullMQ and the bounded
  probes that make it safe to read from, and a `/node` subpath for what only a Node or Bun process
  can do: `fetchPublic`, the SSRF-safe fetch that resolves a customer's URL once and sends to the
  address it checked. The half of that guard a Worker can run is at the root. **No required peer.** `@gusnips/http` is used for its
  types and nothing else, so it erases and is optional; `hono`, `@supabase/supabase-js`, `pg` and
  `ioredis` are optional and reachable only behind their subpaths.
- **`@gusnips/sdkgen`** is the part of an SDK generator that every copy wrote the same way: copying
  the API's own declarations with their comments, writing a JSON Schema as a type, writing the
  methods from the API's operation list, and writing the files through the repo's prettier or
  checking them. The transport those methods run on ships as a file each SDK carries, beside
  `@gusnips/http`'s retry rule, so an SDK installs nothing. What stays in each adopter's script is
  the product: the names, the doc text and the members written by hand.

MIT · open source · npm scope `@gusnips`

## Why it exists

Extracted from eleven private backends that had each written the same three things: a migration
runner (11 copies, 2,799 lines), a type generator (10 copies, 2,893 lines) and an SSL helper (10
copies). They were not copies of each other. Read against each other, they held 16 runner bugs,
and for most of them a sibling repo had already written the fix. The merge is worth more than the
dedup, the same as in frontkit.

The source repos are private and are not named here. **That covers every file, code comment, test
name and commit message, because this repo is public.** Say "a donor", "one runner" or "the second
chain".

## Layout

```
serverkit/
├── migrate/              ← @gusnips/migrate. One required peer: pg.
│   ├── src/
│   │   ├── runner.ts     ← runMigrations(): the whole run, returns a result, never exits
│   │   ├── cli.ts        ← migrateCli(): flags → runMigrations, returns an exit code
│   │   ├── files.ts      ← reads the folder; directives.ts and split.ts parse each file
│   │   ├── target.ts     ← the remote-database guard, also exported for seed scripts
│   │   ├── lines.ts      ← the lines deploy workflows grep. Changing one breaks a workflow.
│   │   ├── db-types.ts   ← the generator; db-types-cli.ts is its command
│   │   ├── stand-in.ts   ← applies sql/supabase-stand-in.sql to a local database
│   │   ├── bin/          ← one bin, gusnips-migrate, which dispatches its two commands
│   │   └── test/         ← the throwaway-database helpers the tests share
│   └── sql/              ← supabase-stand-in.sql, also exported for `psql -f`
├── sdkgen/               ← @gusnips/sdkgen. One required peer: prettier. One dependency: @gusnips/http.
│   └── src/
│       ├── contract.ts   ← liftContract(): the API's declarations, copied with their comments
│       ├── types.ts      ← typeOf() and the field, comment and name writers; never a guess
│       ├── methods.ts    ← sdkMethods(), and retrySource()/transportSource() for the files they run on
│       ├── transport.ts  ← send(): a template each SDK carries, typechecked and tested here
│       └── write.ts      ← writeGenerated(): the repo's prettier, then write or --check
├── server/               ← @gusnips/server. Each optional peer sits behind its own subpath.
│   └── src/
│       ├── errors.ts     ← AppError and createAppError(): your code→status map is the contract
│       ├── responses.ts  ← the envelope both ways: ok/created/paginated, and createErrorResponse
│       ├── logger/       ← createLogger() and the serializer that decides what a log line keeps
│       ├── hono/         ← the edge: errorBoundary, guards, headers, CORS and the four adapters
│       ├── supabase/     ← isAuthOutage(): did auth say no, or fail to answer?
│       ├── pg/           ← createPgPool() with a bounded wait; createIdempotency(); the OAuth store
│       ├── redis/        ← createRedis(), the bounded probes, and the rate-limit window store
│       ├── bullmq/       ← queues that delete finished jobs, the dead letter, the schedule sync
│       ├── mcp/          ← the MCP door: tools that never throw, a limit per call, POST only
│       ├── oauth/        ← sign-in for the MCP door: codes with PKCE, client documents, the device flow
│       ├── openapi/      ← buildOpenApi(): the reference from the operation list, on the public origin
│       ├── rate-limit.ts ← hitWindow() and the memory store; rateLimit() is in hono/
│       ├── client-ip.ts  ← clientIpOf() and ipSubject(): the socket first, a header only from the proxy
│       ├── ip.ts         ← the IPv4 and IPv6 parsers url-guard and client-ip share; not exported
│       ├── url-guard.ts  ← the SSRF check a Worker can run: address, URL shape, redirect, body cap
│       ├── crypto.ts     ← safeEqual() and hmacSha256(), on Web Crypto so a Worker runs them
│       ├── webhook.ts    ← sign and verify, in Stripe's one-header format and Standard Webhooks
│       ├── webhook-delivery.ts ← nextDeliveryStep(): delivered, retry in N seconds, or stop
│       ├── seal.ts       ← createSealer(): AES-GCM for a secret you store, with a key id to rotate
│       ├── token.ts      ← signToken() and verifyToken(): a link that proves who it is for
│       ├── unsubscribe.ts← listUnsubscribeHeaders(): both one-click headers, for any sender
│       ├── text-from-html.ts ← textFromHtml(): a mail's text part from its HTML, addresses kept
│       ├── env.ts        ← validateEnv(): every problem with the environment, in one error
│       ├── node/         ← the one directory allowed Node: fetchPublic(), scryptSealKey(), the API key codec and the drain
│       │   └── mail/     ← createMailer(), the /mail subpath: SMTP needs a socket a Worker lacks
│       └── __tests__/    ← the throwaway redis-server the Redis and BullMQ suites share
├── scripts/
│   └── check-release.ts  ← packs each package and checks what the registry would get
└── AGENTS.md             ← this file
```

Runner, CLI and bin are three layers on purpose. `runMigrations` is testable without a process,
`migrateCli` is what an adopter's five-line script calls, and the bin is what CI calls.

## Commands

```bash
bun install

TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres bun run check
                             # format → build → lint → typecheck → test
bun run release:check        # what the REGISTRY would get: pack, unpack, run under plain node
bun run format
```

`@gusnips/server`'s tests drive a real Hono app and read the bytes back. Its Redis and Postgres
suites start a throwaway server of their own on a free loopback port, and skip, saying so, where
`redis-server` or `initdb` is not installed. A cluster of its own rather than a URL, so no server
test can reach a database somebody cares about. `migrate`'s are integration tests against a real Postgres. Each creates its own
database and drops it after. `TEST_DATABASE_URL` must be on this machine; `test/db.ts` refuses anything else, because the
tests create roles, drop databases and end sessions. Roles belong to the whole cluster, so
`test/global-setup.ts` creates them once before the files run in parallel.

Tests do not run in CI (the fleet's CI minutes policy). Run them before every commit that touches
`src/`. `prepublishOnly` runs them too, so publishing needs `TEST_DATABASE_URL` set.

## Naming and publishing

- **Scope `@gusnips`**, the same as frontkit. `publishConfig.access` is `public` so a release cannot
  go private by default.
- **Release with `bun publish`, never `npm publish`**, and **delete `bun.lock` and reinstall after a
  version bump.** Both rules came from frontkit, where each one shipped a broken tarball. Neither
  bites with one package, and both will the day a second package depends on this one.
  `release:check` already checks both.
- **Adopters resolve from the registry**, never `link:` or `file:`.
- **Nothing is published or pushed without Gus.**

## Invariants — do not regress these

Each one is a bug a donor shipped, or a fix a donor had and the others did not. The tests pin them.
When one fails, a lesson is being unlearned.

1. **Ask before taking the lock, never while holding it.** A runner prompted `[y/N]` while it held
   `pg_advisory_lock`. An operator who walked away blocked the next deploy's runner with no end, and
   no runner set a timeout. The runner also refuses to ask without a terminal: under Bun, `prompt()`
   blocks while stdin stays open, which is what `ssh host 'migrate --manual'` gives it.
2. **The lock comes before any DDL, and the wait for it is bounded.** Six runners created the
   tracking table before locking, and two runners creating it at once on an empty database can fail
   on the catalog's unique index. The wait is 120 seconds by default, and the message names the
   session that holds it. **The wait polls `pg_try_advisory_lock` once a second; it never blocks in
   `pg_advisory_lock`.** A session blocked in that call holds a snapshot for the whole wait. When the
   run holding the lock is building an index CONCURRENTLY in a no-transaction file, the build waits
   for every older snapshot to end, the waiter's included, and the waiter waits for the lock.
   Postgres reports `deadlock detected` after `deadlock_timeout` (1s), long before any
   `lock_timeout`, and kills one side; when that is the build, the index stays INVALID. Reproduced
   in two donor runners, with and without `lock_timeout`, and in this package's test before the fix.
   The key is one default, `727001001`, in every repo; most old runners used another key or none, so
   during the one deploy that swaps a repo's runner an old run and a new run may not exclude each
   other, and that repo's deploy concurrency group is what covers it.
3. **`RESET ALL` before every file.** A `pg_dump` baseline runs
   `set_config('search_path', '', false)`, which lasts for the session, so in three donors every file
   after the baseline failed at its first unqualified name, on any replay from empty. The same dump
   leaves `check_function_bodies = false` on. Measured: `RESET ALL` keeps the advisory lock, and
   restores the `-c search_path` the connection started with.
4. **A no-transaction file is split into statements.** Postgres runs a multi-statement query as one
   implicit transaction, and `CREATE INDEX CONCURRENTLY` refuses to run inside one (measured). Six
   runners sent the whole file at once, on the path one of them documented as the way to run
   `CONCURRENTLY`. The splitter refuses `BEGIN ATOMIC` rather than cut a function body in half.
5. **Directives come from the leading comment block only, and an unknown one is an error.** The old
   marker `-- @manual` meant "gated, in a transaction" in four runners and "no transaction" in six,
   so reading it either way changes one family's files without a word. It is an error now on any
   line of the file, not only at the top: six runners matched it anywhere, so a file marked below its
   first statement was held, and it must not start applying without a word. A `-- migrate:`
   directive after the first statement is an error too, because somebody thinks it is working.
6. **A held file is held, not a halt.** Later files still apply. A halt would turn every gated
   contract migration, which can wait weeks for a person, into a schema freeze. A later file that
   needs a held one fails loudly, in its own transaction. CI replays pass `--manual --yes`, because a
   replay that skipped a held file is exactly how one donor's chain broke.
7. **"Nothing to do" is printed only when nothing is held.** Six runners printed it right under a
   held file. Four more printed it after cancelling the question, and exited 0 with no held-file
   line at all.
8. **The guard counts only what this run would apply.** Two runners counted held files, so a laptop
   run with only a gated file pending refused with "Refusing to apply 1 migration(s)" for a run that
   would apply nothing.
9. **Unknown flags are an error, and nothing runs.** All eleven ignored them, so in the eight with
   no `--status`, `migrate --status` applied every pending file.
10. **`--status` is read-only: no DDL, no lock.** One runner created the schema and table before
    its status branch, so a status check wrote to a fresh database. And a status that cannot reach
    the database exits 1 and prints no `Status:` line. One deploy ended its status command with
    `|| true`, so a dead database printed nothing and read as "up to date".
11. **The runner listens for `error` on the client.** None of the eleven did. When the connection
    drops, pg emits `error` right after it rejects the query, and with no listener that throws, so the
    process died before it could name the file it was applying.
12. **The lines a workflow greps are constants in `lines.ts`, pinned byte for byte.** A chain
    verifier required `Applying 000_baseline.sql (1 of 1)` and failed on every run once the folder
    held six files. And `${LINE#*[MIGRATIONS] }` is a trap in three workflows: in a shell pattern the
    brackets are a set that matches ONE character. It happens to cut the right text on the
    `MANUAL_PENDING` line, which is luck, so the README shows `${LINE#*MANUAL_PENDING }`.
13. **The package runs under plain Node.** No `import.meta.dir`, no `Bun.*`, no `prompt()`. The bin
    test runs under `node`, and `release:check` imports the packed tarball under `node`.
14. **The runner script imports nothing from the app.** One donor's runner imported the app's
    barrel, which loaded an AI client, which threw when its API key was unset, so a schema change
    failed for want of an unrelated key. An adopter's script imports `@gusnips/migrate` and nothing
    else. A seed script that needs the guard imports it from the package, not from the runner
    script, because the runner script runs on import.
15. **Types regenerate only after a run that applied something, and only after the client has
    closed.** One donor's wrapper regenerated types after `--status` too.
16. **One bin, and its name starts with `gusnips-`.** The first build shipped `migrate`, `db-types`
    and `supabase-stand-in`. The first two are unrelated packages on npm, and anyone can register
    the third, so the README's own `bunx migrate`, run in a CI job without this package installed,
    would download a stranger's code and run it with `DATABASE_URL` in its environment. Generic
    names also collide in an adopter's `node_modules/.bin`. `db-types` and `supabase-stand-in` are
    commands under `gusnips-migrate`, read from the first argument before any flag parsing, so an
    unknown flag or a command name anywhere else is still an error. `release:check` refuses a bin
    without the prefix.

### …and four for `db-types`

17. **The output has no timestamp.** The same schema gives the same bytes, which is the only way
    `--check` can compare. `--check` compares after `--format`, because the committed file is the
    formatted one.
18. **A foreign key into another schema is left out of `Relationships`.** The `Database` type
    describes one schema, so the donor generators emitted `REFERENCES auth.users` as a relationship
    to the schema's own `users` table, and a join PostgREST refuses typechecked.
19. **Generated columns and identity `GENERATED ALWAYS` columns are `?: never` in `Insert` and
    `Update`.** Postgres refuses a value for them, so `?: T` typechecked an insert that failed at
    runtime.
20. **`money` and `halfvec` map to `string`.** `money`'s text form is `$1.00`, which is not a JSON
    number.

### The SSL helper

`pgSsl(url)` keeps what ten donor copies did: an `sslmode` in the URL wins, Supabase cloud hosts
connect without a certificate check, and every other host connects without TLS. Whether Supabase
cloud certificates verify with Node's default CA store has not been measured. Until it is,
`sslmode=verify-full` in the URL is how an adopter asks for a check.

### A driver fact

`pg` cannot connect to a bracketed IPv6 URL: `postgresql://…@[::1]:5432/app` fails with `ENOTFOUND`,
because the brackets reach the DNS lookup, while `host: "::1"` connects. Measured with pg 8.23 under
both Bun 1.3.8 and Node 22. It is the driver's, not the runner's, and `describeTarget` stripping the
brackets is still right for the guard. Someone on IPv6 loopback writes `localhost` or passes the
host outside the URL.

### …and thirty for `@gusnips/server`

21. **A success builder returns an ANSWER, not a body — so on Hono, import the adapters.** `ok`,
    `created`, `paginated` and `noContent` in `responses.ts` answer `{ status, body }`, because the
    layer is framework-free and owes its caller a status. Three of three Hono adopters therefore
    wrote the same four unwrapping lines by hand, and one wrote `c.json(ok(data))` instead of
    `c.json(ok(data).body)`: every 200 from a live API answered `{"status":200,"body":{"data":…}}`
    for fifty minutes. **Nothing caught it and nothing could** — `c.json` takes any JSON value so
    the types held, the status stayed 200 so every probe and the deploy gate held, and a test that
    calls the builder never sees the body its caller sends. A client found it, because a client is
    the only reader that parses the envelope. `@gusnips/server/hono` ships the four adapters, so
    the wrong line is not available to write. `noContent` is the half a hand-written adapter gets
    wrong quietly: `c.body(null, 204)`, where `c.json(null, 204)` writes the four bytes `null` and
    a `content-type` under a status that promises neither.

    **And the adapters shipped not delivering that sentence, which is the half worth keeping.** The
    first version was `ok(c, data, status)` over a builder that takes `ok(data, meta?)` — a wrapper
    that NARROWED what it wrapped. The fifth adopter is a metered API whose every read answers
    `{ data, meta }` with what the call cost, and with no slot for it, that repo's `/v1` layer had
    written its own `ok` building the envelope by hand: the exact line this invariant claims is
    unavailable, produced BY the adapter's existence rather than in spite of it. Fixed in 0.2.1
    (`ok<T, M>(c, data, status, meta?)`, generic in the meta like the builder — a page's is
    `PaginationMeta`, a product's is whatever that product measures, and the package does not get
    to name it). The general rule underneath: **a wrapper you have to step around for the common
    case protects nobody**, so an adapter that drops an argument its own builder takes is a bug in
    the adapter, not a smaller API. Check a wrapper against the signature it wraps, not against how
    tidy it reads.

22. **`AppError` defines no `toJSON()`.** `JSON.stringify` calls a value's own `toJSON()` **before**
    the replacer, so an error class that defines one hands a logger whatever that method returns
    instead of the error. Seven backends define one, and all seven log
    `{"error":{"error":{code,message}}}` — doubly nested, no `stack`, no `cause` — from a line that
    still looks like a log line. Our replacer recovers a foreign class from the holder; the fix for
    our own class is not to have the method.
23. **The mask is by CODE, not by status.** `maskedCodes` defaults to `["INTERNAL_ERROR"]`. Masking
    every 5xx flattens a `SERVICE_UNAVAILABLE` into a generic 500 and takes away the one thing
    telling a client whether to wait — in one adopter it made five authored 503 messages, one of
    them written in three locales, unreachable copy. **That default is safe because of the call
    sites, not because of this code**: it holds only while every non-masked 5xx carries a sentence
    somebody wrote for a client. A repo whose repository layer interpolates the driver's message
    wants `maskAll`.
24. **A 429 factory must state its wait, and `null` is one of the answers.** `createAppError` reads
    the literal types of your code→status map, so a 429 arm cannot compile without `retryAfterSecs`
    — which is cheap, because 34 of 40 raises across the fleet already stated one. `null` is the
    other half and the six durable caps are what proved it necessary: a concurrency slot frees when
    somebody else's job ends, and a cap on live objects clears by archiving one. A required `number`
    would have forced both to invent one. **An omission is invisible in a diff; a `null` is a claim
    somebody has to read** — and it is the claim that lets a client delete its hand-maintained list
    of durable codes. **The wait goes out in whole seconds, never below zero**, because
    `Retry-After` is `1*DIGIT`: `errorResponse` rounds a fraction up and reads a past reset as now.
    The adopter that knew this threw a `RangeError` from its error constructor instead, which turns
    the 429 into a 500 at the moment the limiter is busiest.
25. **The mask is bound once, at the edge.** `createErrorResponse` returns the function every door
    imports — the API, a tool wrapper, a worker's health port. The reading found the alternative:
    four places in one fleet deciding the mask separately, and the one furthest from the API getting
    it wrong.

    **It reads a failed parse by shape, so it cannot tell whose data failed.** One adopter checked
    every operation's answer against its response schema with `.parse`. Behind its own mapper that
    was a 500. Behind this one it was the caller's 400, naming the response's own fields back to
    them. That is the price of recognizing validation without importing the validator, and the
    package cannot pay it: a thrown issue list carries no owner. So the rule goes to the adopter.
    Your own data gets `safeParse`, and a failure is raised as your internal 500, with the parse
    as its `cause`.

26. **A log line's error slot allow-lists what a non-`Error` may contribute.** A deny-list has to
    know `payload`, `header`, `raw`, `command`, `where` and the next vendor's word for it, and it
    learns each one from an incident. Measured: a webhook error carries the unverified request body,
    so an unauthenticated route let anyone on the internet write into the log; a Redis AUTH failure
    carries the password in `command.args`; and a Postgres `DatabaseError` carries statement text
    with its literals in `where` and `internalQuery` — reproduced on Postgres 18 with an e-mail
    address and a card number in it. **`stack` is kept**, because a job that dies crosses its queue
    through a serializer and arrives as a plain object, in the one line whose job is to say which
    job died and why.

    **And a secret is hidden by the END of its key, never by a word anywhere in it.** Two backends
    wrote key and value redaction independently, and both matched `token`, `secret` and `api_key`
    anywhere in the key. Measured across the fleet's logger calls (1,085 of them carry an `error`
    key, which is how the extraction was checked): that rule hides **11 fields in 6 repos and not
    one is a secret**, among them `apiKeyId`, which says which key made the request, two booleans
    saying whether a secret was set, and five token counts. Those calls log no key that holds a
    secret. So the rule guards the object nobody meant to log whole, like a request's headers, and
    matching at the end keeps every one of the 11 fields. The value rules are the two that are
    credentials wherever they appear: `Bearer …` and `user:password@` in a URL. E-mail addresses,
    CPFs and product key prefixes are one product's policy, so they are added through `redact`,
    beside the defaults and never instead of them. A value pattern without `g` throws at boot,
    because `replace` would hide the first copy and print the second; a key pattern is matched
    with `search`, because `test` on a `g` pattern resumes from `lastIndex` and prints the next
    key.

    **Anchoring at the end had a cost the first measurement missed: plurals.** A backend moving
    onto this logger held `freeApiKeys`, an array of real provider keys, which its match-anywhere
    rule caught and `…apiKey$` did not. So the rule takes a plural for every word but `token`.
    Swept across every repo's logger calls on 2026-09-24, the only other plurals near a log call
    are token COUNTS (`inputTokens`, `maxTokens`, `promptTokens`), so `tokens` stays out and the
    widening hides no field the fleet logs today. The measurement that justified end-anchoring
    was about what it kept visible; the one it needed was about what it let through.

    The same pass found that the line's `{ ...meta }` spread sat OUTSIDE the `try` that promises a
    logger never throws. A getter on `meta` itself runs during the spread, so it threw out of
    `logger.error`. A getter one level down was fine, because `JSON.stringify` runs that one
    inside the `try`, and that nested case was the only one the test tried.

    **An `Error` passed as the whole of `meta` is filed under `error`.** Spread, it contributes
    nothing: `message` and `stack` are not enumerable, so `.catch((err) => logger.error("…", err))`
    wrote a line that said something failed and nothing about what. `err` is `any` in a promise's
    catch, so no type caught it. Swept on 2026-09-24 before a backend moved onto this logger: 429
    calls in four repos pass the caught error that way, because their own loggers took it. A
    migration that inherits that shape would have emptied every one of those lines.

27. **`assertEveryRouteGuarded` probes the router, and refuses an app with no endpoints.** It asks
    the real matcher which handlers run before each route, rather than reading the code, so a guard
    mounted on the wrong prefix is caught. The empty-app refusal is the important line: a check over
    zero routes passes by asking nothing, which is a guard that has never fired dressed as a green
    one.
28. **The package binds a code union at the RAISE site and cannot bind it at the CATCH site — so an
    adopter with a closed code list writes two lines, and needs to be told.** `createAppError` reads
    a status map's literal types, so a raise is checked. `AppError` and `AppErrorOptions` are
    generic with `= string` defaults, because this package ships no code list; re-export either name
    plainly and every `: AppError` annotation in the adopter becomes `code: string` and every
    factory's `messageKey` widens out of its union. That is silent — it compiles, it passes, and the
    next `switch (err.code)` simply stops being exhaustive. One adopter had **fourteen** such
    annotations and exactly one line the compiler could object to (`EXHAUSTED.has(err.code)`), so
    thirteen would have downgraded with nothing to show for it.

    A function cannot return a type, so there is no version of `createAppError` that closes this.
    What the package owes is the recipe, and it costs nothing because **TypeScript keeps types and
    values in separate declaration spaces**:

    ```ts
    import { AppError as PkgAppError } from "@gusnips/server";
    import type { AppErrorOptions as PkgAppErrorOptions } from "@gusnips/server";

    export const AppError = PkgAppError; // what you `instanceof`
    export type AppError = PkgAppError<ErrorCode, MessageKey>; // what annotations resolve to
    export type AppErrorOptions = PkgAppErrorOptions<MessageKey>;
    ```

    One name, no rename across call sites, and no cast. An adopter whose codes are open needs none
    of it — which is why this is an adopter's line and not a change to the generics' defaults.

29. **Only auth ANSWERING "no" ends a session, and the vendor's own predicate is not enough to
    tell.** `isAuthOutage` lives behind `/supabase` because it imports `@supabase/supabase-js`.
    Every browser client in this fleet reads a 401 as a dead session and signs the person out, so
    a 401 has to mean Supabase looked at the token and refused it; answer an outage with one and a
    single bad minute at auth signs out everybody who was signed in, while the refresh they are
    all waiting on is still in flight.

    The shape is `isAuthRetryableFetchError(error) || status >= 500`, and **the second clause is
    the load-bearing one**. The usual argument for keeping it is drift — the vendor's list was
    `[502, 503, 504]` at auth-js 2.91 and `[500-504, 520-530]` at 2.113.0 — and that argument
    invites "then pin a recent version and drop the clause". The argument that survives: it is a
    LIST, not a range, so it has holes at every version ever shipped. Nothing for 505 through 519,
    nothing from 531 up. A 507 or a 599 out of a proxy in front of GoTrue arrives as a plain
    `AuthApiError` and the vendor's predicate answers false for it, at every version.

    **Twelve backends wrote this predicate before the package did, and all twelve are correct —
    the export is for the comment, not the code.** Measured 2026-09-21 against `origin/main`, with
    the predicate checked as CALLED at the door rather than merely defined. Ten of the twelve
    carried a vendor-version sentence inline, and three of those had gone false by the time anyone
    re-read them; one of the three carried no number at all, which is how it escaped a gate
    written to catch the other two. Three lines of code deduplicated is a bad trade. A sentence
    that has silently gone wrong three times, collapsed to one copy with a test that executes the
    claim, is the whole point.

    **That test asserts the claim, never the numbers.** It pins that a 507 is refused by the
    vendor and caught by us, so it goes red the day the vendor switches to a range — which is the
    day the comment needs rewriting. A version sentence nothing executes is exactly the failure
    above. And it does not build an `AuthApiError` with a 502 on it to stand for "GoTrue answered
    502": auth-js reads its own list in `lib/fetch.js` and hands you an `AuthRetryableFetchError`
    for a LISTED status, so that shape is one the SDK never produces, and a test written that way
    passes for a reason its comment gets wrong. That exact mistake already shipped in this fleet
    and had to be corrected.

    **One shape it cannot catch, and the false is a decision.** auth-js raises `AuthUnknownError`
    when the body does not parse as JSON AND the status is off the list, and that subclass never
    fills the status — so a 507 from a proxy answering HTML is indistinguishable from a malformed
    400 and both read as "not an outage". Widening on the class name was declined: it is raised at
    ANY status, so it would call the malformed 400 an outage too, and a dead session that reads as
    retryable is the same failure from the other side — nobody signed out, and nobody able to sign
    in either. Neither direction is measured, so the narrow answer stays with the analysis beside
    it. The property is also PRESENT and `undefined` rather than absent, because the base
    `AuthError` defines it, which is worse: `"status" in error` answers true and tells you nothing.
    That is why the helper narrows on `typeof === "number"`. The first draft of that test asserted
    "no status at all" and went red — a claim written without measuring, caught by the assertion
    written to pin it.

    Takes `unknown`, not `AuthError`: the fleet asks this from three shapes and only one is
    narrowed. The door holds `AuthError | null` straight off `getUser`; the `catch` around a user
    lookup holds whatever was thrown. The vendor's predicate is itself `(error: unknown)` and
    duck-types on `__isAuthError` plus `name`, so it answers false for `null`, a number, a string,
    a bare `{}` and an ordinary `Error` — measured, not assumed, and the duck-typing is also why
    it keeps working when two copies of the SDK are installed.

30. **A pool with no `connectionTimeoutMillis` does not fail — it goes quiet.** `createPgPool`
    lives behind `/pg` because it imports `pg`, which a Worker cannot run. Read in
    `pg-pool@3.14.0` rather than inferred: with that option unset, a caller that finds the pool
    full is pushed onto `_pendingQueue` **with no timer at all** and waits until a connection
    frees. `max` defaults to 10, so ten slow queries at once are enough — auth, billing, the
    workers and `/health` all hang, with no error, no log and no metric. It is not a 500, it is
    silence, and silence is why it survives in a codebase.

    **Measured 2026-09-21 across `origin/main`: one backend of eleven bounded it.** That one had
    a feature holding a connection across an advisory lock, which turned the latent case live and
    is the only reason anyone looked. The other ten are standing on it. So the default is the
    export — a caller who writes nothing gets 10 seconds, and `connectionTimeoutMillis: 0` is
    still available for a batch job that would rather queue than fail. Spelled out, it is a
    decision; omitted, it is the shape of an accident.

    **`onIdleError` is required by the type, not an option.** All eleven wrote that listener and
    all eleven wrote a comment calling it mandatory, because a `Pool` with no `error` listener
    turns a server closing an IDLE client into an uncaught exception, and a backend whose crash
    handler exits is then killed by a connection nobody was using. Eleven correct copies plus one
    comment each is exactly the case a required field closes for the twelfth.

    **`pingPool` is bounded and the timer is cleared.** A raw `SELECT 1` hangs `/health` when the
    database hangs — which an orchestrator reads as "unknown" where `false` would have meant
    "replace this container"; `connectionTimeoutMillis` does not cover it, because that bounds
    getting a connection and not the query once you hold one.

    **Both counts this paragraph first carried were low, and re-measuring during the sweep is what
    corrected them.** It said four backends ran `SELECT 1` raw; it is **eight of eleven**, in two
    different PLACES — four in the pool module, and four with no probe there at all because theirs
    is inlined in `GET /health` in `apps/api/src/app.ts`. That second group is the lesson: a sweep
    that patched every pool file reported itself complete and had not touched them, because **a
    per-file check answers for the file and not for the bug.** What caught it was asking the fleet
    the question the sweep claimed to have closed, rather than counting the commits it produced.
    And it said one copy was bounded-but-uncleared; it is **three**, and all three left the
    `setTimeout` running, so a process probed every few seconds carried a live timer per probe.

    **A `date` column reads as the day, `"2026-09-23"`, and never as a Date.** pg-types 2.2.0
    parses OID 1082 into a Date at local midnight, so one row is a different instant on every box:
    measured `T00:00Z` under `TZ=UTC`, `T03:00Z` under São Paulo, and `2026-09-22T22:00Z` under
    Berlin, where `toISOString()` names the day before. This package contradicted itself: `db-types`
    has always written `date` as `string`, and the pool delivered a Date. Measured 2026-09-23 across
    the fleet: thirteen `date` columns behind this pool, every one written from the app as a key.
    Of the three places that read one back, two cast to text in SQL to get around the driver, and
    the third typed the column `string` and got a Date from every `RETURNING *`.

    It is set through the pool's own `types`, never the process-wide `setTypeParser`, so another
    pool or library in the process keeps pg's answer; the test runs both pools against a real
    Postgres, because a parser on `options.types` proves nothing until a query goes through it.
    `timestamptz` stays a Date, because that one is a real instant. `date[]` goes through `text[]`'s
    parser. pg-types' typings declare an `arrayParser(source, transform)` that the runtime does not
    have (it is `{ create }`), so the typed call would throw. And it shipped in a minor, not a
    patch: rows are untyped, so a caller doing `row.day.getTime()` breaks at runtime with nothing
    at compile time. A caret on 0.7 does not reach it, and `dateColumns: "date"` keeps the old
    answer for anyone who needs the bump without the change.

    **What did NOT come across, and why.** The `ssl` rule: `@gusnips/migrate` already exports
    `pgSsl`, and the nine hand-written copies were byte-identical in the body — only their
    comments differed, and they differed about WHY Supabase cloud goes unverified. The pool
    **singleton**: every copy wrapped one in a module-level `let`, and a package that holds it
    decides when your process can exit. `connectWithRetry`: four copies, and its `maxAttempts =
Infinity` default turns a typo'd `DATABASE_URL` into a boot that hangs instead of one that
    fails. Type parsers: a global side effect on the `pg` module, and a product decision about
    what a `numeric` column means.

31. **A peer used only for its types is optional, and a sentence saying so is not the
    declaration.** `@gusnips/http` was a REQUIRED peer while being imported in exactly two files,
    both `import type`. Verified the way frontkit's invariant 15 prescribes — against the BUILT
    output, never the source: zero occurrences in any emitted `.js`, and only `.d.ts` references,
    because types erase.

    The cost lands on the adopter who wants the narrowest subpath. `/pg` is a pool factory that
    imports `pg` and nothing else, and taking it meant installing a second package whose code can
    never run. That is what found this: of the ten backends standing on invariant 30's silent
    pool, four carry no `@gusnips/server` at all, so the one-line fix would have arrived as two
    new dependencies.

    **The tell was in our own preamble, one line above the word "required": "only its types,
    which erase".** A document that states the reason a rule is unnecessary, beside the rule, is
    the shape this invariant exists to catch — and it had been read past for four releases.

    **The risk is `skipLibCheck`, and it is measured rather than assumed.** With the peer optional,
    an adopter who uses the `"."` entry and does not install `@gusnips/http` has tsc resolve a
    `.d.ts` reference to nothing. All four of those repos set `skipLibCheck: true` in the
    `tsconfig.base.json` every other config extends, so nothing breaks for them; where it is off,
    the error moves from install time to typecheck time, which is the direction invariant 15
    warns about, and is why this paragraph exists instead of a shrug.

    This is invariant 15 read from the other end. There, an optional peer the barrel imports
    anyway is a required peer with its error moved somewhere worse. Here, a required peer nothing
    imports is an optional peer charging every adopter for a package it never loads. One test,
    the built import graph; opposite answers.

32. **`maxRetriesPerRequest: null` is required by BullMQ, so every read on that connection must
    carry its own bound.** It is the mirror image of invariant 30 and that is the whole point of
    writing it beside it: there the DEFAULT is the silent unbounded wait and `createPgPool`'s job
    is to replace it; here the unbounded wait is the CORRECT setting, because BullMQ's blocking
    reads must never be cut short by a retry limit, and every copy in the fleet sets it
    deliberately. What does not follow, and what nobody wrote down, is that the same connection
    then serves the queues, the limiters, the cache and the health probe — so a `ping`, a cache
    lookup or a `queue.add()` against a down Redis does not fail, it waits.

    **Four backends bound their `PING` exactly right and are safe only because of it. All four
    then leaked the timer** — `Promise.race` against a `setTimeout`, no `clearTimeout` anywhere —
    which is a pending 2-second timer per health check in a process something probes every few
    seconds. `pingRedis` clears it in a `finally`, the same as `pingPool`.

    **And one backend shows what the unbounded half costs when nothing bounds it.** It enqueues
    inbound webhooks on a connection like this with no bound on the enqueue, so during a Redis
    outage every webhook holds its HTTP connection until the caller gives up — while its
    `/health`, which probes Postgres only, stays green. Two separate faults: a health check that
    cannot report the dependency, and a write with no deadline. Fixing the first does not fix the
    second, and reading the config comment is what separates them — it says, out loud, that the
    command timeout was "removed to allow BullMQ operations to complete properly".

    **A bound on `queue.add()` ends the request and not the add.** The README said to bound the
    add of a queue built on first use, and a guide built on the kit found a queue built at boot
    waiting too. Measured with this connection and a stopped Redis: `add()` waited the whole
    35-second outage, and a 2-second timer around it failed the request while the job was still
    added once Redis came back. Checking `status === "ready"` first sends nothing while the client
    is `reconnecting`. `maxRetriesPerRequest: 1` failed that add in 0.3 seconds too, and neither
    helps against a paused Redis: the socket stays open, the status stays `ready`, and the add
    waited all 35 seconds, then landed. `worker.close()` hangs the way a bare `quit()` does (see
    `quitRedis`): without `force`, BullMQ quits the worker's own blocking connection and waits for
    an answer that never comes. Measured still waiting at 40 seconds, idle or busy, while
    `close(true)` disconnects instead and returned in 2 ms.

    **And the `null` could be undone from the URL, with nothing in the code to show it.** ioredis
    reads options from `REDIS_URL`'s query, lets them beat the options passed beside it, and keeps
    each as a string, so `?maxRetriesPerRequest=7` replaced the kit's `null` and
    `?enableOfflineQueue=false` arrived as the string "false", which ioredis reads as on (measured
    on 5.11.1, under bun and node). One backend refused any query in the URL; `createRedis` does
    now, and a test pins the ioredis behaviour, so the guard's reason is checked rather than
    remembered. It refuses the whole query, not only the keys it passes itself, because a string
    value is wrong even where nothing collides. The message names no key: in a URL whose password
    holds an unencoded `?`, the "key" is the rest of the password.

    The connection factory behind all of this was **byte-identical in four backends**, comment
    included, and one of those comments says out loud that it was copied from a sibling repo —
    including the half of it that is false. All four state that an EventEmitter with no `error`
    listener throws, so a blip becomes a process exit through a crash handler. **Measured on
    ioredis 5.10.1, the version the whole fleet runs, under bun 1.3.8 and node 22: the process
    survives and `uncaughtException` never fires.** `silentEmit` in `Redis.js` checks
    `this.listeners(eventName).length` and, finding none, calls `console.error("[ioredis]
Unhandled error event:", ...)` and returns — it never emits, so Node's throw is unreachable by
    construction.

    `onError` stays required for the reason that survives: that `console.error` is a bare stack on
    stderr, outside the logger the app ships every other failure through, and `silentEmit` drops
    the event entirely once the client's status is `end`. **Invariant 30's `onIdleError` is not
    the same case and must not be corrected with it** — checked the same way rather than assumed,
    `pg-pool` calls `pool.emit("error", err, client)` with no listener-count guard anywhere, so
    there the listener really is what stands between an idle-client error and a crash. Copying one
    library's sentence onto another is the whole mechanism here, and four repos copying it is what
    made it look measured. **A sentence four files agree on is still one observation.**

33. **A URL a customer names is checked at every hop, before the hop is sent, and the request
    goes to an address that was checked.** Twelve backends wrote this guard in six independent
    lineages, and each of the three halves was missing somewhere. One followed redirects with
    `redirect: "follow"` and checked only where they ended, so a listener on loopback received
    the request before the check ran (measured). One judged an IPv4-mapped IPv6 address only in
    its dotted form, and `new URL` writes it in hex, so `::ffff:7f00:1` read as public. Five
    checked a name and then let `fetch` resolve it a second time, which is the gap DNS
    rebinding lives in. So `nextHop` re-checks the next URL before anyone dials it, IPv6 is an
    ALLOW-list (2000::/3 minus the blocks that embed an IPv4 address), an address that does not
    parse is not public, and `pinnedRequest` sends to the literal it was handed. A name with one
    private answer among public ones is refused as a whole, which is what makes every surviving
    address equally safe to dial. `allowLoopback` relaxes loopback and nothing else, because two
    donors had a flag that skipped the whole guard and nothing refused it in production.
    `blockedHosts` is a caller's own wall around a public host, and it lives in `checkUrlShape`
    for the same reason the rest does: `resolvePublic` and `nextHop` both run it, so the first
    URL and each redirect refuse it before a name resolves. A check that ran only on the first
    URL would be the "follow, then check the end" mistake again.

34. **The pinned dial rests on a runtime fact, and Bun 1.3.8 gets it wrong.** It sends to the IP
    literal and puts the name in `servername` and in `Host`. Measured with a local CA and against
    a public host: Node 22.22 and Bun 1.4.2 check the certificate against `servername`, refuse a
    wrong one, and fall back to `Host` when there is none. Bun 1.3.8 ignores `servername` and
    checks `Host` verbatim, port included, so an https URL on any other port than 443 is refused.
    It also re-sends a request on its own when a reused connection is reset, so a POST can arrive
    twice. The test file fails in exactly those two places on 1.3.8 and passes on the other two,
    run with each runtime's own `--bun`. One donor's comment credits `tls.serverName` with the
    check, measured against a public host on 1.3.8; that runtime was reading the `Host` header,
    which the donor had also set to the name. Its pinning was safe for a reason other than the
    one it wrote down. **A measurement that agrees with you can still be measuring
    something else.** The same matrix settled a smaller question: under 1.3.8, aborting a
    gzip body ended it early when the REQUEST was destroyed and failed it when the RESPONSE was,
    so `dial` destroys the response once there is one.

35. **A limiter says what a store outage means, and a count that crosses the network has a
    deadline.** Three limiters in the fleet were documented "fails open" and hung instead: the
    shared connection has `maxRetriesPerRequest: null`, which BullMQ needs, so a MULTI against a
    Redis that is down never answers and the `catch` that would allow the request is never
    reached. Measured against a closed port, it was still pending after 15 seconds. So
    `redisWindowStore` takes a required `timeoutMs`, and `whenStoreFails` is required for any store
    that can fail. It has no default, because the fleet uses both answers on purpose: a limit that
    guards a promise allows, and one that guards a bill or a stranger's inbox refuses with the
    product's own 503. The memory store cannot fail, so the types do not ask it. The count and its
    expiry go in one MULTI, because the copy that sent `EXPIRE` separately can lose it and leave a
    key over the limit forever. And the memory store sweeps once per closed window rather than
    once per request: the donors that shed walked all 50,000 keys for every new one while full,
    measured at 3.8 ms of event-loop time per shed request, which made the shed the flood's tool.

36. **A client's address comes from the socket, and a header only from the proxy that wrote it.**
    Most of the fleet read the last `X-Forwarded-For` hop, which is right behind the proxy and only
    there: six APIs listen on every interface, and unless a firewall closes the port, a caller that
    reaches it directly writes that hop itself and picks its own rate-limit window. The one reader
    that asked the socket first then read `X-Real-IP` ahead of the header, and its proxy passes a
    client's own copy through (Caddy's documented default; no Caddy was run to measure it), so the
    header list is a closed type with no `X-Real-IP` in it. Two measured facts shape the rest. On a
    dual-stack socket Bun reports an IPv4 client as `::ffff:127.0.0.1`, so the loopback test folds
    the mapped form first, where a `startsWith("127.")` misses the proxy. And `hono/bun`'s
    `getConnInfo` throws for a request that did not come through `Bun.serve`, so a `peerOf` that
    throws reads as no peer rather than failing every in-process test. No address is `null`, not
    `"unknown"`: seven readers put every such request in one window that one caller could fill for
    everyone.

    **The README's recipe for that peer could not load in a test, and five adopters found it
    separately.** It imported `getConnInfo` from `hono/bun`, whose `ssg.js` reads the `Bun` global
    at module scope, so under vitest on Node the app file failed on its import, before the
    throwing `peerOf` above could help. Measured on hono 4.13.3 and 4.13.8. Two adopters threaded
    `peerOf` into their app factory from the entry point; one read `c.env.requestIP` itself behind
    hand-typed bindings. `bunPeer` is that read, imports nothing, and answers `undefined` where
    there is no server, so the recipe is one line on every runtime a test runs on.

37. **A webhook is checked against its age and against every signature in it, and an unset secret
    refuses.** Three verifiers in the fleet never compared the timestamp to the clock, one of them
    the recipe a product publishes to its customers, so a captured delivery passed forever. Standard
    Webhooks separates signatures with a space and Supabase Auth with `", "`: the verifier that
    split on one space refused every auth hook whenever its secret was the first of two (measured),
    and another kept only the last `v1`, so it could not verify during a rotation. Both formats now
    try every signature against every secret, and they share only the HMAC and the comparison,
    because a fix to one must not change the other. An unset secret is refused by the code, never
    left to the runtime: `safeEqual("", "")` answered `true` in five copies, and Node's `createHmac`
    signs with an empty key where Web Crypto refuses one, so a check that leaned on the runtime was
    closed on Bun and open on Node (measured with the Stripe SDK the fleet pins). And a multibyte
    signature fails rather than throws: one copy compared string lengths and then bytes, which is a
    `RangeError` any stranger could raise.

38. **A stored secret is sealed under a key id, with a 16-byte tag, and a key checked at boot.** Six
    copies in four shapes, and none could rotate: each held one key, and two wrote `v1` in front of
    every value and refused anything else. That `v1` is now a key id, so those two backends' rows
    open unchanged (tested against their `node:crypto` code, in both directions), and a second key
    is a rotation rather than a migration. Node accepts a GCM tag cut short unless it is told the
    length, and one copy opened a value with a 4-byte tag (measured), so the sealer refuses any tag
    but 16 bytes. An empty string seals and opens, where two copies threw. A key must decode to 32
    bytes, checked when the sealer is made: four copies checked only that the variable was set, so a
    one-letter key booted. Each key is imported once, where one copy ran scrypt on every call, at
    least 67 ms of blocked event loop each on the path that handles every inbound message. The keys
    sit in a `Map`, so a stored value naming its key `constructor` finds no key rather than
    Object's. `scryptSealKey` is the one piece in `/node`, because Web Crypto has no scrypt on Node
    or on Bun (measured).

39. **A token the server hands out carries its purpose in the key, and says `expired` only of its
    own signature.** Twelve copies from six derivations. Five backends derive the signing key as the
    HMAC of a service key and a purpose label, so the service key never signs and two doors cannot
    share a token; three other designs signed with an encryption key, and one with the service key
    itself. The kit takes the first design, and without an expiry its token is byte-for-byte theirs,
    because an unsubscribe link must keep working in mail already sent (tested against their
    formula, both ways). An expiring token adds a signed middle segment, and since a payload holds
    no dot, no token can be recut to drop or move its expiry. The signature is checked before the
    expiry, so a "this link expired" page is only ever shown for a token the server signed. The
    shape is checked first, so a token that passes is base64url, digits and dots, safe to write back
    into a page. One design binds an outside value, a username, into its signature. Here that would
    be a hole: MAC-ing `<payload>.<value>` lets a caller who picks the value move the expiry into it
    and drop it. So the value goes in the payload and is compared after verifying.

40. **The environment is checked in one pass, with no value in any message, and a placeholder secret
    stops the boot.** Twelve validators in the fleet, 30 to 60 lines of mechanism each; the list of
    variables stays with the product. One threw at the first problem, so a box with two took two
    restarts. One said a value must never reach the message, because a connection URL carries a
    password, and the kit's messages hold names and lengths only. None of the twelve refused the
    value its own `.env.example` ships. The shapes were measured on the secret lines of every
    `.env.example` the fleet commits: `your-…` (also behind a vendor prefix, `sk-your-…`), `<…>`,
    `…-xxx`, `generate-…`, `change-me` and `dev-only`. A length floor does not catch them: the
    `JWT_SECRET` two repos carry in their self-hosted Supabase example is
    `your-super-secret-jwt-token-with-at-least-32-characters`, 55 characters written to pass the
    floor it is checked against, and one repo's example key passes that repo's own 32-character
    floor. So `secrets` refuses the shape before it measures the length. Only keys named as secrets
    are checked for a placeholder: a secret is random, so a word in it is a placeholder, where
    `EMAIL_FROM` holds words and brackets by design. The source is an argument, because a Worker has
    no `process.env`, and a Worker binding counts as set. Nothing turns the check off: one copy
    returned early under `NODE_ENV=test`.

41. **An API's headers go on outside `errorBoundary`, and CORS compares whole origins.** Seven Hono
    APIs pasted one `secureHeaders` option set word for word, and all seven mounted it inside
    `errorBoundary`. `secureHeaders` writes after `next()`, and a throw that is not an `Error` skips
    that step in every middleware between the throw and the boundary, so a plain-object throw (a
    PostgREST rejection) answered 500 with no HSTS, `nosniff` or CSP (tested in both orders).
    `errorBoundary`'s own doc said to mount it right after `requestLogger`, which is the order that
    loses them; it now names what goes before it. CORS headers survive either order, because `cors`
    sets them before `next()` and Hono copies them onto the answer, so the reason two APIs gave for
    mounting CORS first does not hold on hono 4.13.8. `corsAllowList` compares whole origins, where
    one API matched with `endsWith` and `includes` and let in any site on `pages.dev` (measured). An
    entry that is not an origin throws at boot, and so does one with an opaque origin: that origin
    is the string "null", and allowing it allows every sandboxed iframe. `Retry-After` and
    `X-Request-ID` are always exposed, because a browser hides both from the page otherwise.
    Credentials are off, because no Hono API in the fleet sets a cookie. A preflight is kept 600
    seconds, where the Fetch spec's default is 5. `bodyLimit` needs no wrapper, but it reads a
    chunked body whole before `next()`, so the README puts every check that needs only headers in
    front of it. Bun's default body cap is 128 MiB on 1.3.8 and on 1.4.2 (measured).

42. **A drain runs once, in the order it is given, under a backstop that holds the process open.**
    Thirteen hand-written drains had four defects between them: a worker that always exited 0,
    ten APIs that ran the whole sequence again on a second signal (pg-pool's `end()` then
    rejects), backstops shorter than the work they drained, and a cron nobody could stop. Every
    copy `unref`'d its backstop, and that is a fifth, which none of them knew: when a step hangs
    holding no socket, an unref'd timer lets the process exit 0 in the middle of the drain with
    nothing logged (measured on Node 22, Bun 1.3.8 and Bun 1.4.2). The sequence always ends in
    `exit`, so a live timer keeps nothing alive for longer, and the backstop names the step it
    caught. Bun's `stop()` never resolves while an SSE client is attached, which is why
    `bunServerStep` bounds it; Bun 1.3.8's `stop(true)` does not close that connection either
    (curl still connected 20 seconds later, measured; 1.4.2 closes it at once), so the forced
    stop is bounded too and the steps after it still run. `nodeServerStep` is bounded twice for
    the same reason, one runtime over: Bun 1.4.2's `node:http` `closeAllConnections()` leaves a
    running request open until its handler answers, where Node cuts it at once. The test runs a
    real server on both, because a stub cannot say which runtime keeps the socket.
    `rejections` is required, because the fleet uses both answers on purpose, and a rejection
    listener is installed for both: on Bun a
    rejection with only an `uncaughtException` listener exits 1 at once, skipping the drain,
    where Node hands it to that listener (measured on 1.3.8 and 1.4.2). An uncaught exception
    drains and exits 1 rather than exiting at once, because the backstop already bounds a drain
    the bug has broken. A second signal exits 1 at once, and one within a second of the first is
    the same stop, ignored. This said "a process manager sends one and then SIGKILL, so the second
    comes from a person", and that was false for the fleet's own wrapper: pm2 signals every process
    in the tree (`treekill`), `bun run` forwards SIGTERM to its child too, and the app got SIGTERM
    twice in the same millisecond (Bun 1.4.2, Linux), so the drain was skipped. **The sentence that
    replaced it was false too**: "pm2's default SIGINT is not forwarded and arrives once". The probe
    behind it started the wrapper as a background job of a non-interactive shell, which POSIX starts
    with SIGINT ignored, so the wrapper never saw the signal it was said not to forward. With job
    control on, `bun run` forwards SIGINT exactly as it forwards SIGTERM. Whether the app then sees
    one signal or two is a race: standard signals do not queue, so the pair usually merges before
    the handler runs, and 2 of 28 Linux probes delivered two. That is why nothing had shown it, and
    why a stop skipped the drain now and then rather than every time. A probe for a signal has to
    watch that signal arrive in a control first. The test that pins the window fails on Bun without
    it. The handlers go in before boot, through a function
    that forwards to whichever drain exists: three adopters wrote that by hand in the first wave,
    because the steps need a server that does not exist yet and the donors' crash pair sat on the
    first line. **The first line is not early enough, and this said it was.** Every import runs
    before the body of the file that imports it, so an adopter whose modules build a client as they
    load crashed before its handlers existed: printed raw, with no structured line and no drain. Its
    fix is the README's example now: the handlers go in the entry's first import, which hands over
    the real drain later through `drainWith`. A test boots an entry whose import throws, on Node and
    Bun, with the handlers installed on the entry's first line as the control that must see nothing.
    The budget check stays in the adopter, because
    only the adopter can read its process manager's config; the README gives the order.
43. **A job is final when BullMQ says so, and a finished job is deleted unless you say otherwise.**
    Six `bullmq.ts` copies, four dead-letter files and five schedule syncs, 1,170 lines, and each
    bug in them was one copy missing what another knew. Retention: one backend's Redis reached
    about 16 GB and 14.9 million keys before it set any, and its operator scripts still add jobs
    through a bare `Queue` with none, so the worker sets it too, and a job that chose nothing gets
    the worker's (measured). Final: three of five dead letters counted attempts, and missed the
    failures that end on attempt 1 of 3: an `UnrecoverableError`, a backoff that answers -1, and a
    job that stalled past its limit. BullMQ stamps `finishedOn` only on the branch of
    `moveToFailed` that will not retry, so it answers all three without knowing why the job failed
    (measured on 5.76.4 and 5.81.5, the two ends of the fleet). The stall retry matches BullMQ's
    exact sentence, because one copy matched the word "stalled" and re-ran jobs that failed on their
    own. The schedule sync removes every scheduler its table does not name with one
    `removeJobScheduler`, which also removes an old-style repeat and its delayed job (made on
    5.12.0, removed on 5.76.4 and on 5.81.5), so the donors' `removeRepeatableByKey` branch goes.
    A run that was already due when its scheduler went still runs, once. A cron pattern takes a
    `tz` by type, because one copy ran on the box's clock.

    **This build believed one thing that was false, and a planted defect is what caught it.** A
    probe showed BullMQ refusing `"a:b"` as a custom id, and three donors name their dead-letter
    record `${queue}-${job.id}`, where a scheduler's job id is `repeat:<id>:<ms>`. So the claim was
    that those records are refused and a maintenance job's final failure is lost. BullMQ refuses a
    colon unless the id has exactly two, kept for the old repeat ids, and `maint-repeat:x:123` has
    two. The defect that put the donors' id back survived the suite, and that is the only reason the
    claim never reached a commit. The record here still takes the id BullMQ gives it, for a smaller
    reason: a job id that fails for good twice is recorded twice.

44. **A login never crosses in clear, and every wait on a mail server has a deadline.** Nine
    senders, seven of them pastes of one file. nodemailer upgrades port 587 to TLS only when the
    server's reply to EHLO offers STARTTLS, so somebody on the path who deletes that word gets the
    password: measured against a server with STARTTLS hidden, the login crossed as plain text on
    nodemailer 6.10.1, 7.0.13 and 10.0.10, on Node 22, Bun 1.3.8 and Bun 1.4.2, and `requireTLS`
    stopped it on all nine. One product sets it, in the lanes that dial its customers' mailboxes;
    no system-mail sender does.
    So a login sets `requireTLS`, and no login (a local catcher) does not, which is the only case
    that needs plain text. 12 of 13 senders set no timeout, so nodemailer's 2 minutes to connect
    and 10 minutes of silence applied inside requests somebody was waiting on; one number now
    bounds each wait, and the `ponytail:` in the file names what it does not bound. The text part
    is required because one sender sent HTML only. The one-click header pair is a pure function at
    the root, tested on the bytes that went out, because two senders passed nodemailer's `comment`
    form and tested the options object, which put the second header inside the first.

    **A text part keeps every link's address.** One sender built its text part by stripping tags,
    so its payment reminders said "Pay now" with no address. The next sent HTML only, as whole
    documents with a head and a style block. `textFromHtml` reads both, at the root beside the
    header pair, since neither needs a socket. It decodes entities in one pass, so `&amp;lt;`
    reads `&lt;`, and HTML with no words gives `""` rather than a stand-in: `send` refuses it,
    which is how a mail that is only an image gets noticed before it goes out.

    **Port 587 is safe on Bun, and the reason is narrower than "Bun is fine".** Bun #32239 keeps a
    copy of the ciphertext on the plain socket after a STARTTLS upgrade, and a sibling project moved
    a whole IMAP worker to Node over it. Measured: the copy appears only while the plain socket is
    paused (43 bytes on Bun 1.3.8 and 1.4.2 when the probe paused it, 0 on Node), and nodemailer
    leaves it flowing, so five sends each on both Bun versions went out intact with nothing
    buffered, and the TLS handshake with two public providers on 587 buffered nothing. The IMAP
    smoke test that found it calls `unpipe()`, which pauses the socket. Anything here that drives a
    socket itself and pauses it is back under the bug.

45. **An MCP tool never throws, a limit counts tool calls, and one guard covers both spellings of
    the door.** Eight backends, eight doors, no file-level paste among them, and every fix lived in
    one or two. The SDK (1.29.0 to 1.30.1) catches a handler's throw and answers `err.message` as
    the tool's result, on a 200: three doors rethrew what they could not place, with a comment
    saying the rethrow reached the log, so a driver's `ECONNREFUSED` with an internal address went
    to the agent and no line was written. `registerOperation` answers every `kind` through
    `errorResponse` and logs the raw error for `server` and `unexpected`, as REST does. One POST
    may carry a JSON-RPC batch, and the stateless transport runs every call in it, concurrently,
    under every protocol version, including those that dropped batching (measured with 50): six
    doors limited the POST. So the limit is `beforeCall`, required, with `null` to decline, the
    same shape as `whenStoreFails`. Handed a `.shape`, the SDK parses with a loose object and
    strips an invented key before the handler's own `.strict()` can see it, so `inputSchema` is
    `AnySchema` and a shape does not compile. A GET on the stateless transport answers a stream
    nothing writes to, held until the idle timeout (180-255 s in the fleet), so it gets a 405.

    **The spelling half is two Hono facts, and fixing the first creates the second.**
    `app.route("/mcp", sub)` folds `""` and `"/"` into `/mcp`, so a sub-app serves one spelling:
    five doors answered `/mcp/` with a 404 under a comment claiming both. And
    `app.use("/mcp", guard)` matches `/mcp` exactly, so a door serving both behind that guard
    serves `/mcp/` with no key. Measured on Hono 4.12.26 and 4.13.8: `"/mcp/*"` covers `/mcp`, `/mcp/` and `/mcp/x`. No
    door had the second bug, because the two serving both spellings also guard `"/mcp/*"`. That is
    why the README states the guard and the mount together, and a test pins both statuses.

    `registerOperation` takes `ToolOperation<Deps, unknown, unknown>`, not a generic `Args`. A
    catalog of different operations is a union, and inference over a union argument picks one
    member and refuses the rest, which is exactly the loop four doors write. `run` is a method, so
    it is compared both ways, and `{ id: string }` stands where `unknown` is asked for with no cast,
    also from an app's own operation type whose `run` is a property (tested).

    `title` and the three hints (`readOnlyHint`, `destructiveHint`, `openWorldHint`) are required.
    Claude's and OpenAI's plugin directories both refuse a tool without them (their review rules,
    read 2026-10-16), and six of eight doors set none. Optional, they were left out; required,
    each door's typecheck names the tool that lacks them before a reviewer does. `ToolLabels` is
    a type, not an interface, because an interface does not fit the OpenAPI card's JSON object.

46. **A webhook sender retries what waiting can fix, believes `Retry-After`, and counts on the
    row.** Seven senders, three lineages, and the decision after an attempt was different in each.
    Six retried every 4xx, and no sender read `Retry-After`. Redirects were handled three ways.
    The ladders were a list, five doublings (one from 5 s that gave up after about 15), and one
    flat 30 s, by accident, that gave up about two minutes into an outage. `nextDeliveryStep` makes
    408, 425, 429, 5xx and no answer a retry, a 3xx or any other 4xx final, and takes the larger of
    the ladder's wait and the receiver's, capped at an hour. A cap rather than a refusal, unlike
    the client's rule: nobody is waiting on a spinner here, and an attempt that lands early costs
    one request where giving up loses the event.

    **The attempt number is an argument, because the queue's own count lies.** Honouring a
    `Retry-After` means delaying the job by hand, and measured on BullMQ 5.81.5 a job moved with
    `moveToDelayed` and `DelayedError` keeps `attemptsMade` at 0 on every run, so
    `attemptsMade + 1` would say "first attempt" forever. One sender already counts on its
    delivery row, and the README says to.

    **The breaker is a statement in the README, not code**, because the fleet reaches Postgres
    through two clients, and supabase-js cannot add one to a column. Measured on Postgres 18 with
    20 failures at once and a limit of 10: the one statement tripped once and counted 10. The
    read-then-write two senders use kept 1 of the 20 and never tripped. It counts `failed` steps
    only, so an event being retried does not spend the endpoint's allowance.

    Two planted defects survived the first suite, and both were code that could not matter. The
    ladder's wait is the floor, so a malformed or past `Retry-After` reads the same whether it
    comes out `undefined`, 0 or negative, and `Headers` already trims the value. The sign rule, the
    clamp and the trim went. The survivors were not gaps in the tests.

47. **A write with a key runs once, a claim nobody answered is taken over, and a late run cannot
    touch the claim that replaced it.** Two backends wrote the replay in the same week, and each
    was blind where the other could see. One kept a dead claim "running" until the daily prune, so
    one deploy mid-request answered every retry with 409 for up to 24 hours, and its own SDK, which
    reuses one key across retries, was the caller that got stuck. It answered a failed save with a
    5xx, the answer a client retries, on the key it had just left claimed. And its MCP door took no
    key, because a tool call has no headers. The other took a dead claim over after 15 minutes and
    survived a failed save, but hashed `JSON.stringify` of its parsed input, which is stable only
    while the validator writes keys in schema order. `createIdempotency` is both, plus two things
    neither had.

    **The lease.** Taking a claim over starts a second run while the first may still be going.
    Without a lease, the first run's late save overwrites the second run's answer, and its late
    failure deletes the second run's claim: the copy that took claims over released
    `WHERE answer IS NULL`, and the new claim matches that too. Both are pinned by planted defects.

    **A `Date` fingerprinted as `{}`.** The canonical copy sorted keys by walking objects, which
    never calls `toJSON`, so every `Date` became `{}`, and two requests that differ only in a date
    read as one. Latent there, because none of its operations parses a date today. A
    `JSON.stringify` replacer sees each value after `toJSON`, so the fix is also shorter.

    **A reused key answers 422, as the IETF `Idempotency-Key` draft says.** The two copies
    answered 409 and 400. 409 is already "still running", and a client must retry that one and
    never this one. 400 says the request could not be read, and it could. The package ships no
    codes, so the README names the status.

    Measured on Postgres 18: `jsonb` reorders an object's keys and keeps only the last of two
    duplicates, so the answer column is `json`. node-postgres parses a stored JSON `null` to
    `null`, so "no answer yet" is read as `answer IS NULL` in SQL. Read in JS, a run that answered
    `null` stays "running" until it is taken over and run again. The key is stored hashed, so it
    needs no length limit and a long key is not a 400. The test for that uses a random key: a
    repeated character compresses small enough to fit the index unhashed, so the first version of
    the test passed with the hashing removed.

48. **A reference names the public origin, carries the mount prefix, and uses each operation id
    once.** Five backends each built an OpenAPI 3.1 document from their operation list, in three
    lineages. Four built `servers` from the request's URL. Behind the reverse proxy that is the
    loopback, so all four production references advertised `http://127.0.0.1:<port>`. The fifth
    wrote its production origin by hand, and the audit's first reading called that one the bug.
    One of the four also named no `/v1` while every operation was mounted under it, so the right
    host still answered 404 on every path. And the same one published one operation id five times,
    because one tool rode five paths and the id was `${name}_${method}`. So `origin` and `basePath`
    are required options, and a repeated id throws with both routes in the message. Measured
    against that backend's real catalog, the builder refused its first run on a sixth case: one
    operation on POST and PUT of one path. That is the guard working. The adopter keeps its own id
    rule by passing `operationId`.

    **A 204 has no body, and the kit contradicted itself there.** `noContent` answers 204 with no
    body and no `content-type`, and the builder gave an operation with `status: 204` the same
    `{ data }` body as any other success, so the reference promised a body the route never sends.
    A guide built on the kit found it. A status that carries no body (204, 205, 304) is now
    documented with none, and one handed a `response` or an `example` throws.

    **An operation's SDK place is checked where the list is built.** A generated SDK that does not
    compile fails in somebody's editor, far from the operation that caused it. So the builder
    refuses a method name with more than one dot, one name on two operations, and a return type on
    a status with no body, and names the routes in the message. It writes the place as `x-sdk`,
    which one adopter already did by hand under a name of its own.

    **`default` is two different words in one document.** Under a schema it is data, and the
    translation walk must not touch it. Under `responses` it is the answer to any other status, and
    its description is prose. The first walk skipped the key everywhere, so the catch-all response
    shipped in English, and a test written to collect every string caught it. The walk now reads
    the children of `responses`, `content`, `headers` and `properties` as names, not keywords.
    That also keeps a field NAMED `example` translatable while an `example` VALUE is not.

    **zod writes a recursive schema as `$ref: "#"`, not `$defs`.** Inside the document, `#` is the
    document's root, so the first guard (`"$defs" in json`) let it through, and the planted-defect
    run is what showed it. The guard now refuses a `$ref` of `#`, `#/$defs/…` or
    `#/definitions/…`, and lets through a `#/components/…` ref you wrote yourself.

    Schemas convert through Standard JSON Schema: zod 4.4 and later has it on every schema, and the
    output is byte-identical to `z.toJSONSchema(s, { io })`. So the subpath imports nothing, and
    zod is not a peer. `unrepresentable: "any"` is passed to zod only, because the options are
    vendor-specific. `Retry-After` is documented on 409, 429 and 503, where this package's own code
    sends it, and not on 402, which no raise in the fleet sends it on. All 42 planted defects were
    caught, with a green control.

49. **A sign-in hands out the product's own key, once, and no public route fetches a URL.**
    Lifted from the one backend that had MCP OAuth (362 lines, plus its routes and consent page)
    when both plugin directories made OAuth the price of a listing (2026-10-16). The token is the
    product's own API key, made by `mintKey`, so its key check, keys page and revocation stay the
    only ones. The client id is that backend's envelope byte for byte: HMAC-SHA256 of
    `${purpose}.${body}` under the raw secret, in base64url. claude.ai and ChatGPT keep a client id
    forever, so a new format would have cut every connection already made, and the test signs one
    with `node:crypto` the way that backend did. A code, and an approved device sign-in, change
    state in the same statement that reads them, so two token requests cannot both get a key. A
    planted change that left a polled sign-in `approved` failed the flow test and the race test
    against a real Postgres. Only `deviceClients` may start a device sign-in: a registered client
    names itself, so anyone could start one called "Claude" and send the link to a stranger. A
    metadata document is fetched with no redirect followed, at most 5 KiB, and must name itself as
    its `client_id`. It is fetched only by `describe` and `approve`, behind the product's sign-in:
    the first version also fetched it on the token and device routes, so anyone could make the
    server fetch any https URL, again and again, and a review before the first publish caught it.
    The device page's code check stops a mistyped code, not phishing: somebody can run the real
    CLI and send a stranger the link. The guard is the page saying to go on only if you started
    the sign-in yourself (RFC 8628 §5.4), and the README says so.

50. **An API key keeps the bytes its donors minted, and its shape is checked with the literal
    prefix.** Nine backends mint API keys. Five mint the same one on `node:crypto`, with only the
    prefix changed: 16 random bytes as 32 lowercase hex, SHA-256 of the whole key, 12 characters
    kept for display. `createApiKeyCodec` is those five, and a test pins one key's hash and display
    prefix as computed outside the code (`shasum`), because a change there orphans every stored
    key. Three of the five checked the shape with `new RegExp(`^${prefix}[0-9a-f]{32}$`)`, which
    reads the prefix as a pattern: harmless for the prefixes they use, wrong for the first one with
    a `.` in it. The check here is the literal prefix, the exact length and lowercase hex.

    **A claim made while planning this was false, and measuring it is what caught it.** The
    research said JavaScript's `$` also matches before a final newline, so those three accepted a
    key with `\n` after it. That is Perl's and Python's `$`. Without the `m` flag, JavaScript's
    matches only at the end (measured on Bun 1.4.2 and Node 24.21), so the three refused it all
    along. The test keeps the newline cases, as a pin, not as a fix.

    **What did NOT come across, and why.** A sixth backend mints the same key in a Worker through
    Web Crypto, which is async, and every Node caller hashes on the auth path synchronously. Three
    mint 24 bytes in base64url, one of them showing 10 characters, and one mints 32 bytes with
    8 characters shown from after the prefix: an encoding option comes when one of them adopts,
    not before. Storage, owners, grants, caps and audit are each product's. And a create capped
    per owner stays out: two copies say one `INSERT … SELECT count(*)` keeps concurrent creates
    under the cap, while nothing in it serializes the owner, so two creates can each count the
    snapshot before the other's insert. Nobody has measured it either way. It comes here only
    with a test that races two creates on a real Postgres.

### …and four for `@gusnips/sdkgen`

Five backends each wrote an SDK generator, 426 to 616 lines each and 2,517 in all. What they share
is the reader, the schema writer and the writer, and those came across with every copy's fixes
merged. The method loop and the transport under it came second: the loop was the same in all five
once the product's choices (doc text, a spec field, hand-written members) became options.

51. **A schema the writer does not understand throws. It never becomes `unknown`.** A wrong
    `unknown` in a published SDK compiles for everyone who installs it and tells none of them. The
    writer returns `unknown` only where the schema itself allows any value (`{}`, `true`, the
    values of a bare `object`), and refuses `allOf`, `$ref` and anything else it would have to guess at. The
    fixes were spread across the copies: `type: [..., "null"]` in three, `{}` and a record in two,
    a boolean schema and a tuple in one. `typeNames` reads names inside a generic, where one copy
    split on `|` and missed `JobDto` in `V1ListPage<JobDto>[]`.

52. **The reader keeps every line where it was.** It blanks comments and strings to read the
    structure, then copies the ORIGINAL lines, so the two texts must match line for line. All five
    copies broke that, in four ways, and none had a test for any of them:
    - an escape inside a string dropped its escaped character, or blanked it to a space, so a
      backslash before a line break moved every later line up by one, and each later declaration
      was copied from the wrong lines;
    - an escape inside a `//` comment was honoured too, so a comment ending in `\` blanked the next
      line. Run against one donor's rule, `// C:\` followed by a declaration returned only blanks.
      Two copies guarded it with `state === state`, which is always true;
    - `/*/` closed on the star that opened it;
    - a braced block ended at a lone `}`, so `export interface Empty {}` on one line swallowed the
      declaration after it.

    Two merged fixes are also pinned, because each copy had only some of them: a property KEY is
    not a reference (`VALIDATION_ERROR: 400` names no type), and `(typeof X)[number]` can be
    written as its literal union.

    **That second one is opt-in (`inlineTuples`), and the first adopter is why.** Only one copy
    inlined, and the package first did it always. Rewriting a second backend's generator on the
    package turned up two things. Its SDK does `export * from "./generated/contract.ts"`, so the
    array is a published value there, and inlining it would remove it: a breaking change to an SDK
    nobody meant to touch. And each member of that array carries its own doc comment, which a union
    cannot hold. The same run found a bug in the package's own inliner. It read the members from
    raw text, so the apostrophe in one member's comment (`the media's metadata`) opened a string.
    The members came out as a sentence of prose, and the guard beside it had stripped strings
    before comments, so the same apostrophe hid it from the guard too. Members are now read with
    comments blanked and strings kept. An escape other than a quote or a backslash throws rather
    than being read wrong: `"a\nb"` came out as `anb`. The copy that inlined read the tuple with
    the TypeScript parser, which is right and costs a compiler dependency. This is the same answer
    at the size of the one case that occurs.

    `exportOnlyRoots` is the other half of that copy: only the names asked for stay exported, and
    what they mention is written without `export`. One copy of five did it. It is an option rather
    than an adapter, because `liftContract` returns one string, so a caller cannot tell afterwards
    which declarations were roots.

53. **The output goes through the repo's own prettier before it is compared.** The generated files
    are checked in, so the generator's `--check` and `prettier --check` must never disagree about
    one file. A file that cannot be read for a reason other than not existing throws rather than
    reading as stale, because "stale" would send someone to regenerate over a permission error.

    All 50 planted defects were caught, with a green control. All five donor generators were
    rewritten on the package and ran their own `--check` green, which means every generated file
    came out byte for byte, each generator 267 to 281 lines shorter (1,367 in all). Each check was
    then shown failing on a file with one line appended. zod converts through Standard JSON Schema,
    as in `/openapi`, so zod is not a peer. Unlike `/openapi`, `unrepresentable: "any"` is NOT
    passed: a type zod cannot describe must stop the generator, not become `{}`. One donor did pass
    it. None of its operations needed it, so its output did not change, and the day one does, its
    generator now stops and names the type instead of publishing `unknown`.

54. **The transport asks the retry rule about the answer, and a write is repeatable only with a key
    the server reads.** Of the five SDKs, three decided from their own error class's `retryAfter`,
    a number or nothing, so a server's explicit `details.retryAfterSecs: null` never reached the
    decision; two read the body's wait before the `Retry-After` header and read the header only as
    seconds, so an HTTP date was no wait at all. `send()` builds the rule's input from the answer's
    own fields. A call is keyed exactly when its operation's `headers` name an `Idempotency-Key`:
    one key per call, the same on every attempt. A caller's key on an operation that reads none
    throws, because it would not be sent, and counting the call as repeatable because it carries
    one would retry a write nothing deduplicates.

    The transport is a template, `src/transport.ts`, rather than a string, so it is typechecked and
    tested here; `transportSource()` rewrites its one import to `./retry.ts`. A test generates a
    whole SDK, typechecks it with DOM types and no Node types (what the SDKs publish with), and
    calls an API through it. The retry rule is copied from sdkgen's own `@gusnips/http`, never the
    adopter's, so a release that moves the rule makes every SDK's `--check` fail: that failure is
    the signal to release the SDK.

    Ten planted defects, seven in the transport and three in the emitter, were each caught by a
    named test with the file loaded, and every new test was first watched failing against a stub.

## What the build measured

- **Every donor chain replayed from an empty Postgres 18.** Eleven chains, 313 files, each run as
  stand-in → `migrate --manual --yes` → a second run that applies nothing → `--status`. Eight
  applied as they are. One needed `pgvector` on the server. One needed `pgvector` and a guard around
  an extension it creates and never uses. One stopped before connecting, on purpose, at its one file
  with the old `-- @manual` marker, and applied in full once that marker was renamed. Four chains
  ran with `--search-path app`, because their files name tables without a schema.
- **The generator was proved against the old ones on the same databases.** Four came out
  byte-identical after the header. One differed only in a comment's wording. The other five differ
  by design (relationships, write shapes, helper names), and each was checked with a predicate that
  every `Row` type is unchanged, rather than read by eye.
- **Every test for a donor bug was watched failing first**, by putting the bug back into the runner
  and running the suite.

## House rules

- 2-space, printWidth 100, double quotes.
- Source imports keep real `.ts` extensions; `rewriteRelativeImportExtensions` emits `.js`.
- No `as any` / `as unknown as T`. Fix the type.
- Comments explain **why**, and name the production reason. A rule without its reason gets
  simplified away.
- Errors say what failed, the likely cause, and what to do next.
- The tree may be shared. Stage by pathspec and check `git diff --cached --name-only` before every
  commit.
