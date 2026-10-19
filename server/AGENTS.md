Rules for `@gusnips/server`. Layout, commands, publishing and house rules are in the root
`AGENTS.md`. The server invariants run across three files: 1 to 20 in `migrate/AGENTS.md`, 21 to
52 here, 53 to 56 in `sdkgen/AGENTS.md`. Each one is a bug a donor shipped, or a fix a donor had
and the others did not. The tests pin them.

# Invariants 21 to 52, for `@gusnips/server`

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
    both `import type`. Verified the way the root file's invariant 15 prescribes: against the BUILT
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
    The setup three adopters then copied by hand lives here too (2026-10-19). The signing key is
    HMAC-SHA256 of a secret the server already keeps, under the label `oauth:v1` unless the
    adopter already signed under another (`deriveOAuthSigningKey`); tests pin a derived key for
    each, because every client id already connected was signed under it. An adopter that derived
    its key another way (HKDF) keeps its own line, since a new key disconnects every app. The root
    is refused under 32 characters or in a placeholder's shape, the same rule as `validateEnv`.
    The console routes ask the product's `approver` before every
    yes and never before a no, and answer a body the page would never send as an
    `invalid-request` refusal, never a redirect. `oauthRoutes` counts device starts per caller on
    the POST alone, so a preflight never spends one, and caps its bodies at 64 KiB in OAuth's
    shape. `checkOAuthTable` measures a product's migration against what the store writes. Planted
    changes (a new label, the approver on a no, no device limit, a prefix match without its slash,
    the null check off) each failed one test. `createMemoryOAuthStore` in `/oauth/testing` is the
    kit suite's own fake, run through the same flows as Postgres, so adopters stop writing one
    each; it is a subpath of its own so nobody serves with it.

    **The console routes answer `no-store`, and a Worker can hold the device limit (0.14.3).** The
    first Worker adopter found all three gaps (2026-10-19). `/approve`'s `redirectTo` carries the
    authorization code, and the console routes set no cache header, so the code could sit in a cache
    between the API and the page; only that adopter set `no-store`, by hand. Every console answer
    now carries `Cache-Control: no-store` and `Pragma: no-cache`, the pair the token route already
    sent. The device limit counted in the process's memory, which on a Worker is one isolate among
    many, so `oauthRoutes` takes `rateLimit`'s own store options (`RateLimitStore`): a store that
    can fail comes with what an outage means. And a device key's name was English only, so
    `createOAuth` takes `deviceKeyName`; the adopter had written a device route of its own to strip
    the English half. Planted changes (no header, the store ignored, the name option ignored, the
    name not cut to 60) each failed a test.

    **A document signs in with the method we share, not the one it prefers.** Through 0.13.0 a
    document whose `token_endpoint_auth_method` was not `none` was refused. ChatGPT's (read
    2026-10-19) prefers `private_key_jwt` and also lists `none` in
    `token_endpoint_auth_methods_supported`, so every adopter's consent page told ChatGPT it was
    an unknown app. MCP's SEP-3149 (draft, co-written by OpenAI) is the rule ChatGPT follows: the
    client uses a method from the intersection of its list and ours, and a server must not refuse
    a client only because its preferred method is not shared. Ours is `none`, so that is what a
    document's list must hold; the list beats the single method, the single method must be on the
    list, and a document with neither means `none`. CIMD draft -02 §8.2 says a server MUST require
    `private_key_jwt` from a document that declares it, and verifying that would mean fetching the
    document and its `jwks_uri` on the token route, which anyone may call: the fetch this
    invariant keeps off public routes. So the kit follows the SEP. A `client_assertion` sent
    anyway is ignored: unverified, it neither signs the client in nor fails the exchange, and a
    request with no `client_id` beside it is an unknown client, never one named by the
    assertion's `sub`. Six planted defects, each caught by a named test, with a green control.

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

51. **An operation's REST route reads its input one way, refuses a body it cannot read, and
    validates nothing.** Three backends mounted their operation lists with a loop of their own,
    and each knew something the others did not. Two read the query with `c.req.query()`, which
    keeps the first of a repeated name; the third kept every value, because its filters take
    several. Two read a body that failed to parse as `{}` so the schema would answer, which would
    run a write whose fields all have defaults on a body nobody could read; the third refused it,
    and refused a string, an array or `null` the same way. One read a DELETE's input from its body
    and two from the query. `buildOpenApi` already documents the query, so the route follows the
    reference: a second rule would let the route and its docs disagree. The path's slots arrive
    apart from the input, because one backend keeps them apart and two merge them with the path
    winning, and that merge is one line in `run`.

    **Validation is the product's, because the order is.** One backend checks the owner, the
    grant, the workspace's state and its policy before it parses, and before it looks up a stored
    answer, so a caller who may not call learns nothing about the schema and is never handed a
    replay. A transport that parsed first would undo that, so `run` gets the input as it was read.
    `before` runs ahead of the body limit for the reason invariant 41 gives. A header set inside
    `run` survives a refusal, because `errorHandler` answers through `c.json` on the same context:
    one backend shows what a refused call cost that way, and a test pins it. A 204 drops `data`,
    because one operation can hand its MCP tool a result while its REST answer has no body. Ten
    planted defects, each caught by a named test, with a green control.

52. **An Express backend runs the Hono doors through `fromHono`, mounted before its body parser,
    and the wrong order is refused.** The Hono-only design said no Express adapter, ever. Three
    backends on Express 4, all on Bun, then needed an API and an MCP door, and the doors are Hono
    apps. Writing them again for Express would be two of each, so the doors stay Hono and
    `@hono/node-server`'s `getRequestListener` carries the request across. A probe ran the kit's
    `restRoutes` and `mcpRoutes` inside Express 4.22, under Bun 1.4.2 and Node 24.21, and the plain
    recipe broke twice without a word. Under `app.use("/v1", …)` Express cuts `/v1` off the URL, so
    every route answered 404. And with `express.json()` mounted first, the body was already spent:
    a POST reached the API as `{}`, an MCP call failed as a parse error, and a malformed body got
    Express's HTML page with the stack in it. That second break is the one invariant 51 refuses
    inside the transport, arriving from outside it. So `fromHono` restores the full URL and refuses
    a request whose `body` a parser already set, with an error that says to move it. Both are
    planted-defect tested against a real Express. It sits in `src/node/` because it takes Node's
    request, and imports no Express: its request type is the two fields it reads.

    **And it shipped with a third break of the same kind, which the first adopter's proof found.**
    `getRequestListener` replaces the process's global `Request` and `Response` with its own
    classes unless `overrideGlobalObjects` is `false`, and it does so when the listener is made, so
    mounting the API changed every other fetch in the process, far from any route. The probe above
    tested requests through the bridge and never looked at the globals. Through 0.14.1 `fromHono`
    left it on. The test reads both globals before any bridge exists and checks them after one
    serves, so a swap by any earlier test still shows; with the old call put back it fails on Node
    and on Bun.
