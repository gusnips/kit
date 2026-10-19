Rules for `@gusnips/sdkgen`. Layout, commands, publishing and house rules are in the root
`AGENTS.md`. The server invariants run across three files: 1 to 20 in `migrate/AGENTS.md`, 21 to
52 in `server/AGENTS.md`, 53 to 56 here.

# Invariants 53 to 56, for `@gusnips/sdkgen`

Five backends each wrote an SDK generator, 426 to 616 lines each and 2,517 in all. What they share
is the reader, the schema writer and the writer, and those came across with every copy's fixes
merged. The method loop and the transport under it came second: the loop was the same in all five
once the product's choices (doc text, a spec field, hand-written members) became options.

53. **A schema the writer does not understand throws. It never becomes `unknown`.** A wrong
    `unknown` in a published SDK compiles for everyone who installs it and tells none of them. The
    writer returns `unknown` only where the schema itself allows any value (`{}`, `true`, the
    values of a bare `object`), and refuses `allOf`, `$ref` and anything else it would have to guess at. The
    fixes were spread across the copies: `type: [..., "null"]` in three, `{}` and a record in two,
    a boolean schema and a tuple in one. `typeNames` reads names inside a generic, where one copy
    split on `|` and missed `JobDto` in `V1ListPage<JobDto>[]`.

54. **The reader keeps every line where it was.** It blanks comments and strings to read the
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

55. **The output goes through the repo's own prettier before it is compared.** The generated files
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

56. **The transport asks the retry rule about the answer, and a write is repeatable only with a key
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
