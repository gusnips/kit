# kit

The layer under a TypeScript app: the build rig, the fetch client, the auth store, the guards and
the tokens for a Vite + React frontend, and the migrations, the errors and the API edge for a Bun
or Node server on Postgres. Ten packages on npm, under `@gusnips`. You install only the ones you
use.

Not a component library. There is no Button here, and there never will be: the two best copies
in the repos this came from are 104 lines and 60 lines, and they share the idea and nothing
else. Behaviour is shared, skin is not.

```bash
bun add @gusnips/react
```

```ts
import { cn } from "@gusnips/react";

cn("p-2", "p-4"); // → "p-4"
```

## Ten packages

For the frontend:

| Package                               | What it is                              | Needs         |
| ------------------------------------- | --------------------------------------- | ------------- |
| [`@gusnips/tokens`](tokens/README.md) | one Tailwind 4 `@theme` file            | nothing       |
| [`@gusnips/http`](http/README.md)     | the request/response envelope, as types | nothing       |
| [`@gusnips/locale`](locale/README.md) | where a language lives in a URL         | nothing       |
| [`@gusnips/br`](br/README.md)         | CPF, CNPJ, Brazilian phones and CEP     | nothing       |
| [`@gusnips/cnpj`](cnpj/README.md)     | a company's public record, by CNPJ      | `@gusnips/br` |
| [`@gusnips/react`](react/README.md)   | the headless runtime                    | react         |
| [`@gusnips/vite`](vite/README.md)     | the prerender rig and the vite preset   | node          |

For the server:

| Package                                 | What it is                                                    | Needs      |
| --------------------------------------- | ------------------------------------------------------------- | ---------- |
| [`@gusnips/migrate`](migrate/README.md) | a SQL migration runner, a type generator, a Supabase stand-in | `pg`       |
| [`@gusnips/server`](server/README.md)   | errors, the response envelope, logging, and the API's edge    | nothing    |
| [`@gusnips/sdkgen`](sdkgen/README.md)   | the parts of a script that writes your API's TypeScript SDK   | `prettier` |

They are ten and not one because of what each consumer can afford to install. An Astro
marketing site wants the tokens and no JavaScript. An API server wants the envelope and the
CNPJ check, and no React. A browser bundle wants the runtime and no `node:fs`. The build script
is the only thing that needs the filesystem, so it is the only thing that gets it.

That column is a promise, and the build checks it. Anything a package needs beyond what is
listed there lives behind a subpath, so you install it only by importing it: the Base UI
wrappers at `@gusnips/react/ui`, the auth store at `/store`, the route guards at `/guards`,
`react-dom` at `/hydrate`, the renderer at `@gusnips/vite/render`, Hono at `@gusnips/server/hono`.
A package that generates your sitemap installs no React, and a React Native app installs no
`react-dom`.

They live in one repo because the server packages use `@gusnips/http` too. A change to the
envelope lands on both sides in one pull request.

## What the frontend packages do

**Talks to your API.** One client, so nothing else calls `fetch`. It carries the token,
refreshes it once when a 401 comes back, and unwraps the envelope.

```ts
import { createApiClient } from "@gusnips/react";

const api = createApiClient({
  baseUrl: "https://api.example.com",
  session: mySessionAdapter,
  onSessionDead: () => window.location.replace("/sign-in"),
});

const user = await api.get<User>("/me");
```

Two things in there took a production incident each to learn. Six queries firing at once send
**one** refresh, not six. The auth server rotates the refresh token, so the losers of that race
each invalidate the winner and sign the person out mid-load. And a refresh that never _reached_
the auth server does not count as a refusal: dropping a packet says nothing about whether a
session is good, so a Wi-Fi blip no longer signs anyone out.

**Survives your deploys.** An app with `lazy()` routes serves chunks by hashed filename. Deploy
while someone has a tab open and their next click asks for a file that no longer exists: a
white screen on a button that worked a minute ago.

```ts
import { installPreloadErrorHandler, isChunkLoadError } from "@gusnips/react";
```

**Prerenders pages a crawler can read.** Nothing that reads a link for a living runs your
bundle, so a shipped `<div id="root"></div>` is a page that can be listed and never quoted.

**Keeps you from dead-ending anyone.** `ErrorStateProps` requires both a `fix` and an `action`.
A required prop is the only version of that rule a caller in a hurry cannot skip.

## What the server packages do

**Runs your migrations.** Put plain `.sql` files in a folder:

```bash
bun add @gusnips/migrate pg
```

```bash
DATABASE_URL=postgresql://postgres@localhost:5432/app bunx gusnips-migrate --dir migrations
```

That applies every `.sql` file in `migrations/` that has not run yet, in order, each in its own
transaction.

**Gives your API one error shape.** `@gusnips/server` holds the error class, the
response envelope that `@gusnips/http` describes, a JSON logger, and the Hono middleware that
turns a thrown error into that envelope.

**Writes your SDK.** `@gusnips/sdkgen` copies your API's types with their comments and writes a
method for each operation, so the SDK cannot drift from the API it calls.

## Where it came from

Twelve private frontends, all on the same stack, that had each independently grown the same
layer, about 48,000 lines solving one problem nine times. Six filenames exist in all twelve.
Then eleven backends, each with its own migration runner, and ten with their own type generator:
about 5,700 more lines.

They were not copies, and that is the point. Three of the frontends separately invented the same
hydration guard, down to the attribute name. Three separately invented single-flight token
refresh. Three wrote three different retry rules, and **each one was right about something the
other two got wrong**: one allowed 408 through, one knew a spent quota does not clear by
waiting, one refetched on reconnect. All three are in here now.

The runners were the same. Each had fixed something the others had not, and each still had a bug
another had already fixed. A few of them:

- A runner asked "apply this? [y/N]" while holding its lock. Nobody answered, and the next deploy
  waited on that lock with no end.
- In eight runners, `migrate --status` ignored the flag it did not know and applied every pending
  file.
- A database dump sets `search_path` to empty and leaves it that way for the session, so replaying
  from an empty database failed at the first file after it.
- A status check that could not reach the database printed nothing, and the workflow read nothing
  as "up to date".

These packages are the merge, with each of those pinned by a test.

## Docs

[`GUIDE.md`](GUIDE.md) shows how we lay out a project and why, then builds one small app on these
packages from an empty folder: its API and its web app. [`GUIDE-2.md`](GUIDE-2.md) grows the same
app: pages a search engine can read, a second language, background jobs, mail, webhooks, an
OpenAPI reference, and a public API with keys and an MCP door.

`AGENTS.md` is the real document: the rules each package keeps, each with the incident behind it.
Each server package keeps its own rules in its folder (`server/AGENTS.md`, for example), and
[`MIGRATIONS.md`](MIGRATIONS.md) is what moving each app onto these packages taught.

## Develop

```bash
bun install
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres bun run check
bun run release:check
```

The migration tests need a Postgres on this machine that they may create and drop databases in.
They refuse any other host.

MIT.
