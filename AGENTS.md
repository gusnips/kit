Entry point for AI agents working on this repo.

# kit

**The layer under a TypeScript app, in ten packages.** Seven sit under a Vite + React SPA and three
under a Bun or Node server on Postgres. They share one repo because the server packages use
`@gusnips/http` too: a change to the envelope lands on both sides in one pull request, and
`server` and `sdkgen` build against the `http` beside them, not the one on npm.

MIT · open source · npm scope `@gusnips`

## Where the rules live

This file holds what every package shares, the frontend's rules and the server packages' layout.
The rest sits beside the code it is about, and each of those folders has a `CLAUDE.md` that imports
its `AGENTS.md`, so an agent reading files there gets the rules with them. Read the one for the
folder you change.

| File                | What it holds                                                          |
| ------------------- | ---------------------------------------------------------------------- |
| `react/AGENTS.md`   | frontend invariants 16 to 21, for anything under `react/src/ui/`       |
| `tokens/AGENTS.md`  | the token contract, measured                                           |
| `migrate/AGENTS.md` | server invariants 1 to 20, the SSL helper, and what the build measured |
| `server/AGENTS.md`  | server invariants 21 to 50                                             |
| `sdkgen/AGENTS.md`  | server invariants 51 to 54                                             |
| `MIGRATIONS.md`     | what moving each app onto the frontend packages taught                 |

The two halves number their invariants separately. "Invariant 8" in this file, in `react/` or in
`tokens/` is the frontend's retry rule. In `migrate/`, `server/` or `sdkgen/` it is the server
list, which runs across those three files.

The source repos are private and are not named here; nothing about the packages depends on
knowing which they were. **That covers every file, code comment, test name and commit message,
because this repo is public.** Say "the first adopter", "a donor", "one runner" or "the second
migration". Names already got into the history once, and the only fix was rewriting all of it
before the first push.

## The frontend packages

**The layer under a Vite + React SPA.** The build rig, the fetch client, the auth store, the
guards, the tokens — everything twelve products wrote twelve times. Deliberately **not** a
component library: no styled Button, no brand, no illustrations. Those are where a product
lives and they stay in the app.

### Why they exist

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

### Layout

```
kit/                    ← repo root (this folder), git root
├── tokens/             ← @gusnips/tokens: one Tailwind 4 @theme file. Zero deps.
├── http/               ← @gusnips/http: the envelope; /retry, when to try again. Zero deps, no framework.
├── locale/             ← @gusnips/locale: where a language lives in a URL; /time, what day it is; /money, what a language pays in. A leaf.
├── br/                 ← @gusnips/br: CPF, CNPJ, Brazilian phones, CEP. Zero deps.
├── cnpj/               ← @gusnips/cnpj: a company by its CNPJ, from a registry or four public APIs. Needs br.
├── react/              ← @gusnips/react: the headless runtime. One required peer: react.
│   └── src/ui/         ← the seven Base UI wrappers, behind a subpath (see below)
├── vite/               ← @gusnips/vite: the build rig. The ONLY frontend package allowed node:fs.
├── migrate/ sdkgen/ server/ ← the server packages, laid out under "The server packages"
├── scripts/            ← check-purity.ts, check-exports.ts and check-release.ts, the guards
├── MIGRATIONS.md       ← what moving each app onto the frontend packages taught
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

`locale/` is a **leaf**: nothing in this repo imports it, deliberately. A package that depends on
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

## The server packages

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

### Why they exist

Extracted from eleven private backends that had each written the same three things: a migration
runner (11 copies, 2,799 lines), a type generator (10 copies, 2,893 lines) and an SSL helper (10
copies). They were not copies of each other. Read against each other, they held 16 runner bugs,
and for most of them a sibling repo had already written the fix. The merge is worth more than the
dedup, the same as in the frontend packages.

### Layout

```
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
└── server/               ← @gusnips/server. Each optional peer sits behind its own subpath.
    └── src/
        ├── errors.ts     ← AppError and createAppError(): your code→status map is the contract
        ├── responses.ts  ← the envelope both ways: ok/created/paginated, and createErrorResponse
        ├── logger/       ← createLogger() and the serializer that decides what a log line keeps
        ├── hono/         ← the edge: errorBoundary, guards, headers, CORS and the four adapters
        ├── supabase/     ← isAuthOutage(): did auth say no, or fail to answer?
        ├── pg/           ← createPgPool() with a bounded wait; createIdempotency(); the OAuth store
        ├── redis/        ← createRedis(), the bounded probes, and the rate-limit window store
        ├── bullmq/       ← queues that delete finished jobs, the dead letter, the schedule sync
        ├── mcp/          ← the MCP door: tools that never throw, a limit per call, POST only
        ├── oauth/        ← sign-in for the MCP door: codes with PKCE, client documents, the device flow
        ├── openapi/      ← buildOpenApi(): the reference from the operation list, on the public origin
        ├── rate-limit.ts ← hitWindow() and the memory store; rateLimit() is in hono/
        ├── client-ip.ts  ← clientIpOf() and ipSubject(): the socket first, a header only from the proxy
        ├── ip.ts         ← the IPv4 and IPv6 parsers url-guard and client-ip share; not exported
        ├── url-guard.ts  ← the SSRF check a Worker can run: address, URL shape, redirect, body cap
        ├── crypto.ts     ← safeEqual() and hmacSha256(), on Web Crypto so a Worker runs them
        ├── webhook.ts    ← sign and verify, in Stripe's one-header format and Standard Webhooks
        ├── webhook-delivery.ts ← nextDeliveryStep(): delivered, retry in N seconds, or stop
        ├── seal.ts       ← createSealer(): AES-GCM for a secret you store, with a key id to rotate
        ├── token.ts      ← signToken() and verifyToken(): a link that proves who it is for
        ├── unsubscribe.ts← listUnsubscribeHeaders(): both one-click headers, for any sender
        ├── text-from-html.ts ← textFromHtml(): a mail's text part from its HTML, addresses kept
        ├── env.ts        ← validateEnv(): every problem with the environment, in one error
        ├── node/         ← the one directory allowed Node: fetchPublic(), scryptSealKey(), the API key codec and the drain
        │   └── mail/     ← createMailer(), the /mail subpath: SMTP needs a socket a Worker lacks
        └── __tests__/    ← the throwaway redis-server the Redis and BullMQ suites share
```

Runner, CLI and bin are three layers on purpose. `runMigrations` is testable without a process,
`migrateCli` is what an adopter's five-line script calls, and the bin is what CI calls.

## Commands

```bash
bun install                  # workspace root

TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres bun run check
                             # format → build → lint → typecheck → purity → exports → test
bun run purity               # the platform guards on their own: the frontend's, then server's
bun run exports              # every export resolves, and no optional peer is in a main barrel
bun run release:check        # what the REGISTRY would get: pack, unpack, run under plain node
bun run build
bun run format               # prettier --write; run it before pushing
```

Per package: `cd react && bun run test`, etc.

`@gusnips/server`'s tests drive a real Hono app and read the bytes back. Its Redis and Postgres
suites start a throwaway server of their own on a free loopback port, and skip, saying so, where
`redis-server` or `initdb` is not installed. A cluster of its own rather than a URL, so no server
test can reach a database somebody cares about. `migrate`'s are integration tests against a real Postgres. Each creates its own
database and drops it after. `TEST_DATABASE_URL` must be on this machine; `test/db.ts` refuses anything else, because the
tests create roles, drop databases and end sessions. Roles belong to the whole cluster, so
`test/global-setup.ts` creates them once before the files run in parallel.

Tests do not run in CI (the fleet's CI minutes policy). Run them before every commit that touches
`src/`. `prepublishOnly` runs them too, so publishing needs `TEST_DATABASE_URL` set.

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
- **Publish in dependency order** (`tokens`, `http`, `locale`, `br`, `cnpj`, `react`, `vite`, then `migrate`, `sdkgen`, `server`), and bump `vite` whenever
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

- **The server packages are published and pushed only with Gus.** That rule came with them.

## What must NOT be shared

This rule is what keeps the package alive; violating it is how design systems die. Each of
these was checked against the code, not assumed.

- **`packages/ui/src/brand/` stays in each product.** One product has a bird, one has a
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

## Frontend invariants — do not regress these

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
   `packages/server`, and a server must not depend on a package named react. That half is
   `isAuthOutage` in `@gusnips/server/supabase`, the vendor's predicate with the clause beside it.

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
   by archiving one — `@gusnips/server` answers with an explicit body `retryAfterSecs` of `null`,
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

Six more, 16 to 21, are in `react/AGENTS.md`, and the token contract is in `tokens/AGENTS.md`.

## House rules

- 2-space, printWidth 100, double quotes (matches `.prettierrc`).
- Source imports keep real `.ts` extensions; `rewriteRelativeImportExtensions` emits `.js`.
- No `as any` / `as unknown as T`. Fix the type.
- Comments explain **why**, especially the non-obvious production reason. That is most of the
  value being preserved here — a rule without its reason gets "simplified" away next quarter.
  When a comment in a donor file names a real incident, it comes across with the code.
- Errors say what failed, the likely cause, and what to do next.
- The tree may be shared. Stage by pathspec and check `git diff --cached --name-only` before every
  commit.
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
