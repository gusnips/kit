# Build an app with the @gusnips packages, part 1

This guide builds one small app from an empty folder. It is called `notes`: you sign in, you see
your notes, and you add one. It has an API (Hono on Bun, with Postgres) and a web app (Vite and
React), and it uses the `@gusnips` packages the way they fit together.

Each step shows the smallest code that works, then the one rule that has already hurt a real app,
then a link to the package README for everything else.

Every snippet here comes from a copy of this app that was built and run while the guide was
written, on Bun 1.4.2, with the versions in the catalog below. Sign-in ran against a small local
server that answers the way Supabase Auth does, not against a real Supabase project.

You need:

- Bun.
- Postgres, on your machine for now.
- A Supabase project, for sign-in. You need its URL and its anon key.

Part 1 covers [how we lay out a project, and why](#how-we-lay-out-a-project-and-why),
[setting up the repo](#set-up-the-repo), [the API](#the-api),
[running the API](#running-the-api) and [the web app](#the-web-app).
[What's next](#whats-next) lists part 2.

## How we lay out a project, and why

This is how most of our apps are built, and why. Where they differ, this follows the newest ones.

### One repo for each product

A product's API, web app, public site and background worker live in one repo, as Bun workspaces.
A change to the API and the page that reads it then lands in one commit, and one review covers
both.

- One lockfile, `bun.lock`, and the Bun version in `packageManager`, so every machine installs the
  same versions.
- One catalog of versions, so every workspace gets the same copy of each package.
  [Set up the repo](#set-up-the-repo) shows it.
- turbo runs a task in every workspace and skips the ones whose inputs did not change.
- `bun run check` at the root runs lint, types, tests, the build, Prettier and knip. One command
  answers "is this ready?"

### The folders at the top

```text
notes/
├── apps/
│   ├── api/        the HTTP API
│   ├── web/        the app people sign in to
│   ├── site/       the public pages: home, pricing, terms
│   └── worker/     jobs that run outside a request
├── packages/
│   ├── server/     code the API and the worker both use
│   ├── shared/     types and constants the browser and the server both read
│   ├── ui/         the look: theme, logo, styled components
│   └── sdk/        a typed client for a public API
├── infra/          how each app runs on a server
├── scripts/        tasks for the whole repo: setup, checks
├── docs/           decisions and how-tos
├── AGENTS.md       what a new person, or a coding agent, reads first
├── package.json
├── turbo.json
└── tsconfig.base.json
```

Start with `apps/api`, `apps/web` and `packages/shared`. Add the rest when you need it.

- **`apps/`** holds what you deploy. **`packages/`** holds what the apps import. A package is never
  deployed on its own.
- **`packages/shared`** also runs in the browser, so it holds no secrets and imports nothing from
  Node. The error codes and the shapes the API sends live here, so the API and the web cannot
  disagree about them.
- **`packages/server`** holds the product's rules: `config/` (the environment check), `infra/`
  (Postgres, Redis, queues, email), `logger/`, and `modules/<name>/`, one folder for each part of
  the product. The API and the worker stay thin: one turns requests into calls, the other turns
  jobs into calls. The example in this guide has one table and no worker, so its few server files
  stay in `apps/api/src`.
- **Migrations** live in `apps/api/migrations/`, numbered: `001_notes.sql`, `002_…`. The API owns
  the database, and the numbers show the order at a glance.
- **`infra/`** holds what an app needs on a server: its pm2 file, its systemd drop-in, and the
  scripts that install them, in one folder per app. These files change how production runs, so
  they go through review like code. They sit outside `apps/` because nothing in them is part of a
  build.

An app imports packages. A package never imports an app, and an app never imports another app.
That keeps each package usable by every app, and lets each app deploy on its own.

### Inside the API

```text
apps/api/
├── migrations/       001_notes.sql, …
├── scripts/          run-migrations.ts
└── src/
    ├── index.ts      starts the server, and stops it cleanly
    ├── app.ts        the Hono app: middleware first, then routes
    ├── routes/       one file for each group of endpoints
    ├── middleware/   auth, CORS, rate limits
    ├── composition/  connects each module to the real database, queue and mailer
    └── lib/          small helpers only the API uses
```

An API that other developers call also has `operations/`: one definition for each endpoint, and
the routes, the OpenAPI file and the SDK are all built from it. Part 2 covers that.

### Inside the web app

```text
apps/web/src/
├── main.tsx        mounts the app
├── App.tsx         the routes
├── index.css       Tailwind and the theme
├── pages/          one component for each route
├── components/     parts the pages share
├── services/       the API client and the Supabase client
├── stores/         zustand stores, like who is signed in
├── hooks/          React hooks the pages share
├── lib/            small helpers: the query client, the error describer
└── i18n/           the text in each language, and the type that checks its keys
```

### Tests

A test sits next to the file it tests and shares its name: `api.ts` and `api.test.ts`. When you
move or delete a file, its test is right there. Older apps kept tests in `__tests__/` folders; the
newest put them next to the file. Tests run with Vitest.

### Config and the environment

- Each app has its own `.env.example`. It lists every variable the app reads, and it is committed.
  Copy it to `.env`, which is never committed. Bun reads `.env` from the folder it runs in.
- The API checks every variable when it starts, with `validateEnv`, and stops with a list of what
  is wrong. A missing variable then fails at boot, where you see it, and not on the first request
  that needs it.
- The web app reads only `VITE_` variables. Vite copies them into the bundle, and anyone can read
  the bundle, so a secret never goes in one.

### The stack

- **Bun** runs TypeScript as it is, so the API ships as source with no build step. It also
  installs the packages.
- **Hono** for the API: a small router built on the web's own `Request` and `Response`, so a test
  calls `app.request("/notes")` with no server running. `@gusnips/server/hono` has its middleware.
  A few older apps use Express; the newest all use Hono.
- **Postgres** for the data, through `pg` and plain SQL migrations anyone can read.
- **Supabase Auth** for sign-in: passwords, email links and Google, which you should not write
  yourself. It is open source and keeps its users in Postgres.
- **Redis and BullMQ** for jobs that must outlive a request, like sending an email or an import.
  A job survives a restart and retries on its own. A few apps queue jobs in Postgres instead; the
  newest ones all use BullMQ.
- **React 19.** Its `react-dom/static` renders a page with `lazy()` routes to finished HTML, which
  prerendering needs (part 2).
- **Vite** runs the dev server and the build. `webPreset` sets it up in one line.
- **react-router 7** for routes. The guards in `@gusnips/react/guards` use it.
- **Tailwind 4.** Styles sit in the markup, and the theme is CSS variables. That is how
  `@gusnips/tokens` names the colours and swaps them for dark mode.
- **TanStack Query** for every read from the API. It caches, retries, and tracks loading and
  errors. `queryDefaults` gives it the retry rule.
- **zustand** for the little state that is global, like who is signed in. A store is one function,
  with no provider to wrap around the app.
- **i18next** for text. Every string lives in a catalog, so a second language changes no
  component. A `.d.ts` file types the keys, so a missing key is a compile error.
- **zod** checks what comes in, and the same schema gives you its TypeScript type.
- **pm2 on a plain server** (a VPS) runs the API and the worker. It restarts them when they crash,
  and gives them time to finish when you deploy. **Caddy** sits in front for HTTPS.
- **A static host** serves the web app and the site. After the build they are only files, so the
  API is the only server you run. Most of our apps use Cloudflare Pages. Its `_redirects` file
  sends every address to `index.html`, so a reload on `/notes` still finds the app.
- **ESLint, Prettier and knip.** knip finds files and exports nothing uses.

### Rules for the code

- **No `as any`, and no `as unknown as T`, outside tests.** Fix the type. A cast tells the
  compiler to stop checking, so the bug it would have caught ships. ESLint's `no-explicit-any`
  rule catches the `any`. In a test, a cast is fine with a comment that says why.
- **Comments say why, not what.** The code already says what it does. The reason, often something
  that broke once, is what the next person needs before they "simplify" it.
- **Every error and every empty page tells the reader what to do next.** An error says what
  failed, why, and how to fix it, with a retry when one can work. An empty page says what belongs
  there and how to add the first one. `ErrorStateProps` does not compile without a fix and an
  action, and `EmptyStateProps` does not compile without a description.
- **Write copy a child and a junior developer can both read.** Short sentences, common words, and
  numbers instead of adjectives: "That file is 12 MB. The limit is 10 MB." says more than "Upload
  failed."
- **One API client.** Every call to your API goes through it, so the token, the refresh, the
  retries and the error shape live in one place. Nothing else calls `fetch` on your API.
- **Conventional commits, scoped to the workspace:** `fix(web): …`, `feat(server): …`. The scope
  says which part changed. The body says why.

### What each app keeps for itself

The brand, the styled components like `Button`, and the colours stay in each app. The packages
share behaviour. The look is the product, and a shared styled `Button` that has to fit every brand
grows a new option for each one, forever.
[What must not be shared](AGENTS.md#what-must-not-be-shared) has the full list and the reasons.

## Set up the repo

The example starts with the three workspaces every app has, plus the files the API needs on a
server:

```text
notes/
├── apps/
│   ├── api/        Hono on Bun
│   └── web/        Vite and React
├── packages/
│   └── shared/     types both apps import
├── infra/
│   └── api/        the pm2 file and the systemd drop-in
├── package.json
├── turbo.json
└── tsconfig.base.json
```

### One version of each package

The root `package.json` lists the workspaces, and a catalog: one version range for each package
the repo uses.

```json
{
  "name": "notes",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.4.2",
  "workspaces": {
    "packages": ["apps/*", "packages/*"],
    "catalog": {
      "@gusnips/http": "^0.1.3",
      "@gusnips/migrate": "^0.1.0",
      "@gusnips/react": "^0.9.15",
      "@gusnips/server": "^0.8.16",
      "@gusnips/tokens": "^0.1.1",
      "@gusnips/vite": "^0.8.24",
      "@supabase/supabase-js": "^2.117.2",
      "@tailwindcss/vite": "^4.3.3",
      "@tanstack/react-query": "^5.103.2",
      "@testing-library/react": "^16.3.3",
      "@types/bun": "^1.4.2",
      "@types/pg": "^8.23.1",
      "@types/react": "^19.3.0",
      "@types/react-dom": "^19.3.0",
      "@vitejs/plugin-react": "^6.1.1",
      "hono": "^4.13.9",
      "jsdom": "^30.1.1",
      "pg": "^8.23.0",
      "react": "^19.3.0",
      "react-dom": "^19.3.0",
      "react-router-dom": "^7.18.4",
      "tailwindcss": "^4.3.3",
      "typescript": "^5.9.3",
      "vite": "^8.3.1",
      "vitest": "^4.1.2",
      "zod": "^4.6.5",
      "zustand": "^5.0.15"
    }
  },
  "scripts": {
    "check": "turbo run typecheck test build",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test"
  },
  "devDependencies": {
    "turbo": "^2.11.4",
    "typescript": "catalog:"
  }
}
```

A workspace then asks the catalog instead of naming a range: `"@gusnips/react": "catalog:"`.
`bun run check` runs the types, the tests and the build in every workspace. Add lint to it when you
add ESLint.

**Keep one range per package.** When two workspaces ask for two ranges, the install can put two
copies of a package in the tree, and it says nothing. We tried it: one workspace on `0.9.14` next
to the catalog's `^0.9.15` gave two copies of `@gusnips/react`, and `bun install` printed no
warning. `bun why @gusnips/react` prints one heading per version it installed. One heading is
what you want.

`@gusnips/vite` depends on the exact `@gusnips/react` it was released with (`0.8.24` needs
`0.9.15`), so change those two ranges in the same commit.

### Builds turbo can cache

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "env": ["VITE_*"],
      "outputs": ["dist/**"]
    },
    "typecheck": {},
    "test": {}
  }
}
```

**List the `VITE_` variables as build inputs.** Vite copies every `VITE_` variable into the bundle
when it builds. If turbo's cache ignores them, a production build can reuse the bundle a staging
build saved, with the staging API address inside. One team shipped exactly that.

turbo already adds `VITE_*` on its own when a workspace depends on vite. Keep the line anyway.
We turned that guess off (`--framework-inference=false`) and removed the line: the build got no
API address at all, and the next build reused that broken bundle from the cache.

A `<package>#build` entry replaces `build` instead of adding to it. So if you add one, for example
to list `dist-ssr/**`, repeat the `env` line and the `dependsOn` in it.

### TypeScript

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

That is `tsconfig.base.json`. Bun and Vite run TypeScript themselves, so `tsc` only checks
(`noEmit`), and imports keep their `.ts` ending. Each workspace extends it. This is the API's:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["bun"]
  },
  "include": ["src", "scripts", "vitest.config.ts"]
}
```

**Put every folder with code in an `include`.** A script outside every tsconfig is checked by
nothing, and nothing warns you. The migration script lives in `scripts`, so `scripts` is listed.

### The shared package

```ts
// packages/shared/src/index.ts
// The codes the API answers with. The web reads them too, so both import this one union.
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE";

export interface Note {
  id: string;
  title: string;
  createdAt: string;
}
```

Its `package.json` is named `@notes/shared` and exports `./src/index.ts`, so it has no build step.
Both apps list it as `"@notes/shared": "workspace:*"`.

## The API

A Hono app on Bun. It depends on `@gusnips/server`, `@gusnips/http`, `@gusnips/migrate`, `hono`,
`pg`, `zod`, `@supabase/supabase-js` and `@notes/shared`, and tests with `vitest`. Its scripts:

- `dev`: `bun --watch src/index.ts`
- `migrate`: `bun scripts/run-migrations.ts`
- `typecheck`: `tsc --noEmit`
- `test`: `vitest run`

Copy its `.env.example` to `apps/api/.env` and fill it in:

```text
PORT=3000
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/notes
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
APP_URL=http://localhost:5173
```

Bun reads `.env` from the folder you start it in, so run every API command from `apps/api`.

### Check the environment at boot

`validateEnv` stops the boot with one list of everything that is wrong.

```ts
// apps/api/src/env.ts
import { validateEnv } from "@gusnips/server";

validateEnv(process.env, {
  required: ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY", "APP_URL"],
  fix: "Copy apps/api/.env.example to apps/api/.env and fill it in.",
});

export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
  appUrl: process.env.APP_URL ?? "",
};
```

With no `.env`, the API stops with this message:

```text
The environment has 1 problem:
- These are not set: DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, APP_URL
Copy apps/api/.env.example to apps/api/.env and fill it in.
```

**It never prints a value.** A database URL carries a password, and this message goes to a boot
log. `validateEnv` checks, but it does not change the types, so `env` reads each value once more
as a `string`.

It can also check that a secret is long enough, and that related variables are set together:
[the environment](server/README.md#the-environment).

### Log

```ts
// apps/api/src/logger.ts
import { createLogger } from "@gusnips/server";

export const logger = createLogger({ level: process.env.LOG_LEVEL });
```

It writes one JSON line per event to stdout.

**Pass the error itself**, as in `logger.error("save failed", { error })`, never `String(error)`.
The logger writes the message, the stack and the cause, and hides the values of keys like
`password`, `token` and `authorization`.
[Logging a failure](server/README.md#logging-a-failure).

### One shape for every refusal

Every answer is `{ data }` or `{ error: { code, message } }`. A route throws, and one handler turns
the throw into that shape. You choose the codes; `ErrorCode` is in the shared package above.

```ts
// apps/api/src/errors.ts
import { createAppError, createErrorResponse } from "@gusnips/server";
import type { ErrorCode } from "@notes/shared";

export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const satisfies Record<ErrorCode, number>;

const appError = createAppError(ERROR_STATUS);

export const errors = {
  unauthorized: () => appError("UNAUTHORIZED", "Sign in to continue"),
  notFound: (what: string) => appError("NOT_FOUND", `${what} not found`),
  rateLimited: (retryAfterSecs: number) =>
    appError("RATE_LIMITED", "Too many requests", { retryAfterSecs }),
  unavailable: (message: string) => appError("SERVICE_UNAVAILABLE", message),
};

export const errorResponse = createErrorResponse<ErrorCode>({
  internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
  validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
});
```

A route that throws `errors.unauthorized()` answers 401 with:

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Sign in to continue" } }
```

**The `satisfies` line is the one that matters.** Add a code to `ErrorCode` without a status, and
the build fails instead of a route answering 500 for a refusal it knew how to explain. A code that
answers 429 must also say how long to wait: leave out `retryAfterSecs`, and TypeScript stops with
`Expected 3 arguments, but got 2`.

`@gusnips/http` declares that shape once, and the API, its tests and the web's client all read it
from there. `isApiError<ErrorCode>(body)` is true for an error body, and then `body.error.code` is
one of your codes. The API's test below uses it.
[Refusing a request](server/README.md#refusing-a-request),
[turning a throw into an answer](server/README.md#turning-a-throw-into-an-answer),
[the envelope](http/README.md#the-envelope).

### The app, and a health check

```ts
// apps/api/src/app.ts
import {
  apiSecureHeaders,
  corsAllowList,
  created,
  errorBoundary,
  errorHandler,
  notFoundHandler,
  ok,
  requestLogger,
  type RequestVariables,
} from "@gusnips/server/hono";
import { pingPool } from "@gusnips/server/pg";
import type { ErrorCode } from "@notes/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "./auth.ts";
import { pool } from "./db.ts";
import { env } from "./env.ts";
import { errorResponse, errors } from "./errors.ts";
import { logger } from "./logger.ts";

export type AppEnv = { Variables: RequestVariables<ErrorCode> & { userId: string } };

export const app = new Hono<AppEnv>();

app.use(requestLogger({ logger }));
app.use(apiSecureHeaders());
app.use(corsAllowList([env.appUrl]));
app.use(errorBoundary);
app.onError(errorHandler({ errorResponse, logger }));
app.notFound(notFoundHandler(errorResponse(errors.notFound("Route"))));

app.get("/health", async (c) => {
  const up = await pingPool(pool, {
    timeoutMs: 2_000,
    onError: (error) => logger.warn("[pg] down", { error }),
  });
  if (!up) throw errors.unavailable("The database is not answering");
  return ok(c, { db: "up" });
});
```

```text
$ curl -s localhost:3000/health
{"data":{"db":"up"}}
```

With Postgres stopped, the same call answers 503 with
`{"error":{"code":"SERVICE_UNAVAILABLE","message":"The database is not answering"}}`. `pingPool`
gives up after 2 seconds, so `/health` does not hang when the database does.

Every answer also carries HSTS, a content policy that loads nothing, and an `X-Request-ID`. A
browser may call the API only from a page at `APP_URL`.

**Keep this order, and keep `errorBoundary`.** Hono hands `onError` only real `Error` objects.
Anything else a route throws skips it: the connection drops with no answer, and the browser
reports a CORS error, which sends you looking in the wrong place. The boundary wraps such a throw
in an `Error`. `apiSecureHeaders` goes above the boundary, because a middleware below it never gets
to add its headers when such a throw passes through.
[Hono](server/README.md#hono),
[the headers on every answer](server/README.md#the-headers-on-every-answer).

### Postgres and migrations

```ts
// apps/api/src/db.ts
import { pgSsl } from "@gusnips/migrate";
import { createPgPool } from "@gusnips/server/pg";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

export const pool = createPgPool({
  connectionString: env.databaseUrl,
  ...pgSsl(env.databaseUrl),
  onIdleError: (error) => logger.error("[pg] idle client error", { error }),
});
```

`pgSsl` reads the URL and decides whether to use TLS.

**`onIdleError` is required.** When Postgres restarts, it closes the connections the pool keeps
open, and with no listener Node turns that into a crash. The pool also stops waiting for a free
connection after 10 seconds. Plain `pg` waits forever: with ten slow queries running, every
request after them hangs with no error.
[Postgres](server/README.md#postgres).

A migration is a `.sql` file in `apps/api/migrations`:

```sql
-- apps/api/migrations/001_notes.sql
CREATE TABLE app.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_user_id_idx ON app.notes (user_id, created_at DESC);
```

```ts
// apps/api/scripts/run-migrations.ts
import { migrateCli } from "@gusnips/migrate";

process.exitCode = await migrateCli({ dir: new URL("../migrations", import.meta.url) });
```

`bun run migrate` prints the database it connected to, then:

```text
[MIGRATIONS] Applying 001_notes.sql (1 of 1)...
[MIGRATIONS] ✓ Applied 001_notes.sql.
[MIGRATIONS] Done. Applied 1 migration(s); 0 were already applied.
```

Run it again and it says `All migrations already applied. Nothing to do.` It creates the `app`
schema and its own `app.schema_migrations` table the first time.

**Each file runs in one transaction, and there are no down migrations.** If a file fails, none of
it stays. To undo a change, write a new file. The runner also refuses to apply anything to a
database that is not on your machine unless you pass `--yes`, because a laptop's `.env` sometimes
points at production.
[@gusnips/migrate](migrate/README.md).

### Who is asking

The web sends the Supabase access token in `Authorization`. The API asks Supabase whether the
token is good.

```ts
// apps/api/src/auth.ts
import { createClient } from "@supabase/supabase-js";
import { guard } from "@gusnips/server/hono";
import { isAuthOutage } from "@gusnips/server/supabase";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./app.ts";
import { env } from "./env.ts";
import { errors } from "./errors.ts";

const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const requireUser = guard(
  createMiddleware<AppEnv>(async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /i, "");
    if (!token) throw errors.unauthorized();

    const { data, error } = await supabase.auth.getUser(token);
    if (isAuthOutage(error)) throw errors.unavailable("Sign-in is not answering right now");
    if (error || !data.user) throw errors.unauthorized();

    c.set("userId", data.user.id);
    await next();
  }),
);
```

**An outage is not a no.** A browser reads a 401 as "your session is over" and signs the person
out. If Supabase is down and the API answers 401, everyone who makes a request in that minute is
signed out. `isAuthOutage` tells the two apart, so the API answers 503, and the web retries. We
made the local stand-in answer 500, 503 and 507, then stopped it: the API answered 503 each time.
[Supabase Auth](server/README.md#supabase-auth).

The rest of `app.ts` puts the guard in front of the notes routes:

```ts
// apps/api/src/app.ts, after /health
app.use("/notes/*", requireUser);

type NoteRow = { id: string; title: string; createdAt: Date };

app.get("/notes", async (c) => {
  const { rows } = await pool.query<NoteRow>(
    `SELECT id, title, created_at AS "createdAt" FROM app.notes
     WHERE user_id = $1 ORDER BY created_at DESC`,
    [c.get("userId")],
  );
  return ok(c, rows);
});

const NewNote = z.object({ title: z.string().trim().min(1).max(200) }).strict();

app.post("/notes", async (c) => {
  const { title } = NewNote.parse(await c.req.json().catch(() => null));
  const { rows } = await pool.query<NoteRow>(
    `INSERT INTO app.notes (user_id, title) VALUES ($1, $2)
     RETURNING id, title, created_at AS "createdAt"`,
    [c.get("userId"), title],
  );
  return created(c, rows[0]);
});
```

A zod error needs no handling of its own. A title of two spaces answers 400 with the field and the
rule it broke, and never the value that was sent:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request could not be read",
    "details": [{ "path": ["title"], "code": "too_small", "minimum": 1 }]
  }
}
```

`c.req.json()` throws on a body that is not JSON, and that throw would answer 500. The `.catch`
hands zod a `null` instead, so the caller gets a 400.

### Test that every route is guarded

The tests import the app, and the app checks the environment as it loads, so the test config gives
it values. No test connects to them.

```ts
// apps/api/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/notes_test",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_ANON_KEY: "test",
      APP_URL: "http://localhost:5173",
      LOG_LEVEL: "silent",
    },
  },
});
```

```ts
// apps/api/src/app.test.ts
import { isApiError } from "@gusnips/http";
import { assertEveryRouteGuarded, underAny } from "@gusnips/server/hono";
import type { ErrorCode } from "@notes/shared";
import { expect, test } from "vitest";
import { app } from "./app.ts";

test("every route but /health needs a signed-in user", () => {
  assertEveryRouteGuarded(app, { isPublic: underAny(["/health"]) });
});

test("a request with no token gets the error envelope", async () => {
  const res = await app.request("/notes");
  const body: unknown = await res.json();

  expect(res.status).toBe(401);
  expect(isApiError<ErrorCode>(body) && body.error.code).toBe("UNAUTHORIZED");
});
```

**A guard added after its routes never runs.** The route answers anyway, and nothing tells you.
`assertEveryRouteGuarded` asks Hono's own router what runs in front of each route. Move the
`app.use("/notes/*", requireUser)` line below the routes, and the test fails:

```text
Error: 2 endpoint(s) answer with no guard running in front of them:
  GET /notes
  POST /notes
```

[The guard check](server/README.md#the-guard-check).

## Running the API

### Crash handlers go in the first import

```ts
// apps/api/src/crash-handlers.ts
import { createShutdown, installProcessHandlers, type Shutdown } from "@gusnips/server/node";
import { HARD_EXIT_MS } from "./budget.ts";
import { logger } from "./logger.ts";

let drain: Shutdown = createShutdown([], { hardExitMs: HARD_EXIT_MS, logger });
installProcessHandlers((reason, code) => drain(reason, code), { logger, rejections: "survive" });

export function drainWith(shutdown: Shutdown): void {
  drain = shutdown;
}
```

```ts
// apps/api/src/index.ts
import { drainWith } from "./crash-handlers.ts"; // the first import
import { bunServerStep, createShutdown } from "@gusnips/server/node";
import { app } from "./app.ts";
import { HARD_EXIT_MS, REQUEST_GRACE_MS } from "./budget.ts";
import { pool } from "./db.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

const server = Bun.serve({ port: env.port, fetch: app.fetch, maxRequestBodySize: 1024 * 1024 });
logger.info("listening", { url: server.url.href });

drainWith(
  createShutdown(
    [
      bunServerStep(server, { graceMs: REQUEST_GRACE_MS }),
      { name: "postgres", run: () => pool.end() },
    ],
    { hardExitMs: HARD_EXIT_MS, logger },
  ),
);
```

**Install the crash handlers in the first import, not the first line.** Every import runs before
the file that imports it. So when `env.ts` throws as it loads, the first line of `index.ts` has not
run yet, and a handler installed there never sees the crash. The first import runs before the
others. Until `drainWith` hands over the real steps, a crash is logged and the process exits 1
(lines shortened):

```text
{"error":{"name":"EnvError","message":"The environment has 1 problem:\n…","stack":"…"},"level":"error",…,"message":"uncaught exception"}
{"reason":"uncaught exception","level":"info",…,"message":"shutting down"}
{"exitCode":1,"ms":0,"level":"info",…,"message":"shutdown complete"}
```

With the handlers imported after `app.ts` instead, the same crash printed Bun's raw error and a
slice of source code, and nothing went through the logger.

`maxRequestBodySize` is there because Bun otherwise takes a request body of up to 128 MiB.

### Stopping for a deploy

A process manager stops the API with a signal, waits, then kills it. In between, the drain stops
taking requests, gives the ones in flight time to finish, and closes Postgres last. Press Ctrl+C on
`bun run dev` and you see it:

```text
{"reason":"SIGINT","level":"info","time":"2026-09-25T13:50:57.044Z","message":"shutting down"}
{"step":"http server","level":"info","time":"2026-09-25T13:50:57.044Z","message":"shutdown step"}
{"step":"postgres","level":"info","time":"2026-09-25T13:50:57.045Z","message":"shutdown step"}
{"exitCode":0,"ms":1,"level":"info","time":"2026-09-25T13:50:57.045Z","message":"shutdown complete"}
```

Four numbers decide whether that finishes. Two live in the API: how long a request in flight gets
to finish, and how long the whole drain may take.

```ts
// apps/api/src/budget.ts
// How long a deploy waits. Each number must be larger than the one before it:
// the longest request < HARD_EXIT_MS < pm2's kill_timeout < systemd's TimeoutStopSec.
// budget.test.ts reads all four and checks the order.
export const REQUEST_GRACE_MS = 5_000;
export const HARD_EXIT_MS = 25_000;
```

One in the pm2 file:

```js
// infra/api/ecosystem.config.cjs
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "notes-api",
      cwd: path.join(__dirname, "../../apps/api"),
      script: "src/index.ts",
      interpreter: "bun",
      kill_timeout: 30_000,
    },
  ],
};
```

And one in systemd, when pm2 runs under it:

```ini
# infra/api/override.conf
# Installed with `sudo systemctl edit pm2-<user>`. Must stay above kill_timeout.
[Service]
TimeoutStopSec=60s
```

From the repo root, `pm2 start infra/api/ecosystem.config.cjs` starts it, and `pm2 stop notes-api`
sends SIGINT, which runs the same drain. `cwd` points at the API's folder, so Bun finds
`apps/api/.env` there.

pm2 loads the entry with `require()`. So the entry, and every file it imports, must not `await` an
import or a file outside a function. If one does, the API can print its start line and still die:
pm2's error log shows `require() async module … is unsupported`, and pm2 restarts it over and over.
Load the module with `createRequire`, read the file with `readFileSync`, or move the `await` into a
function.

**Each number must be larger than the one before it:** the longest request, then `HARD_EXIT_MS`,
then pm2's `kill_timeout`, then systemd's `TimeoutStopSec`. If one is too small, deploys cut
requests off halfway, and nothing reports it. pm2's `kill_timeout` is 1.6 seconds unless you set
it, and the unit `pm2 startup` writes sets no `TimeoutStopSec`, so systemd's default applies. One
API had a 25-second `hardExitMs` under a 70-second kill timeout, raised for requests that run up
to 60 seconds, so every deploy cut those requests off at 25.

So a test reads the numbers from the files and checks the order:

```ts
// apps/api/src/budget.test.ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { HARD_EXIT_MS, REQUEST_GRACE_MS } from "./budget.ts";

const require = createRequire(import.meta.url);
const infra = "../../../infra/api";
const pm2: { apps: { kill_timeout: number }[] } = require(`${infra}/ecosystem.config.cjs`);
const unit = readFileSync(new URL(`${infra}/override.conf`, import.meta.url), "utf8");

test("a deploy stops the API before anything kills it", () => {
  const killTimeoutMs = pm2.apps[0]?.kill_timeout ?? 0;
  const stopMs = Number(unit.match(/TimeoutStopSec=(\d+)s/)?.[1]) * 1_000;

  expect(2 * REQUEST_GRACE_MS).toBeLessThan(HARD_EXIT_MS);
  expect(HARD_EXIT_MS).toBeLessThan(killTimeoutMs);
  expect(killTimeoutMs).toBeLessThan(stopMs);
});
```

It doubles the grace because the server step can wait it out twice while a stream is open (seen
on Bun 1.3.8). Set `kill_timeout` to `20_000` and the test fails with
`expected 25000 to be less than 20000`.
[Stopping for a deploy](server/README.md#stopping-for-a-deploy).

## The web app

Vite, React 19, react-router 7, TanStack Query and Tailwind 4. The web app depends on
`@gusnips/react`, `@gusnips/tokens`, `@notes/shared`, `@supabase/supabase-js`,
`@tanstack/react-query`, `react`, `react-dom`, `react-router-dom` and `zustand`. It builds with
`@gusnips/vite`, `vite`, `@vitejs/plugin-react`, `tailwindcss` and `@tailwindcss/vite`, and tests
with `vitest`, `jsdom` and `@testing-library/react`. Its `dev` script is `vite`.

Copy its `.env.example` to `apps/web/.env` and fill it in:

```text
VITE_API_URL=http://localhost:3000
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### The Vite config

```ts
// apps/web/vite.config.ts
import { webPreset } from "@gusnips/vite/preset";
import { defineConfig } from "vite";

export default defineConfig(webPreset({ root: import.meta.dirname, port: 5173 }));
```

`webPreset` adds the React and Tailwind plugins, points `@` at `src`, and sets the dev port.
`vite preview` runs on the port minus 1000, so 4173 here. `root` is required: it is the folder that
holds `index.html`. [The vite preset](vite/README.md#the-vite-preset).

### Colours

```css
/* apps/web/src/index.css */
@import "tailwindcss";
@import "@gusnips/tokens/index.css";

@theme {
  --color-primary: #1d4ed8;
  --color-primary-foreground: #ffffff;
}
.dark {
  --color-primary: #93c5fd;
  --color-primary-foreground: #0b1220;
}
```

You can now write `bg-card text-card-foreground` anywhere, and it follows light and dark mode. The
page itself gets `<body class="bg-background text-foreground">` in `index.html`.

**Set each colour twice, once for light and once for dark.** Skip the dark one, and your daytime
colour stays on screen at night. And `--color-input`, the border of a text field, needs 3:1
contrast against `--color-background`, or some people cannot see where to type.
[Two names you cannot pick freely](tokens/README.md#two-names-you-cannot-pick-freely).

### The API client

Tell TypeScript about the `VITE_` variables:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
}
```

That is `apps/web/src/vite-env.d.ts`. Then, in `services/`, one Supabase client, and one API client
for everything else:

```ts
// apps/web/src/services/supabase.ts
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
```

```ts
// apps/web/src/services/api.ts
import { createApiClient, returnPathFromLocation } from "@gusnips/react";
import { createSupabaseSessionAdapter } from "@gusnips/react/supabase";
import { supabase } from "./supabase.ts";

export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL,
  session: createSupabaseSessionAdapter(supabase.auth),
  onSessionDead: () => {
    const next = encodeURIComponent(returnPathFromLocation(window.location));
    window.location.replace(`/sign-in?next=${next}`);
  },
});
```

`api.get<Note[]>("/notes")` sends the token, returns what is inside `{ data }`, and throws an
`ApiError` for anything else.

**Only Supabase saying no signs anyone out.** When a request comes back 401, the client refreshes
the token once and tries again. If the refresh fails because the network dropped or Supabase
answered 5xx, the person stays signed in. Only a real refusal calls `onSessionDead`. Six requests
that get a 401 together share one refresh, because Supabase replaces the refresh token each time
it is used, and six refreshes would undo each other.

`returnPathFromLocation` keeps the page and its query, and drops a `#access_token=…` fragment, so
the sign-in address never carries a token. This test runs the real adapter through three failed
refreshes:

```ts
// apps/web/src/services/api.test.ts
import { createApiClient } from "@gusnips/react";
import { createSupabaseSessionAdapter } from "@gusnips/react/supabase";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, expect, test, vi } from "vitest";

// A session whose token has expired, with a refresh that fails the way we choose.
function sessionWhoseRefresh(error: Error) {
  return createSupabaseSessionAdapter({
    getSession: async () => ({ data: { session: { access_token: "expired" } } }),
    refreshSession: async () => ({ data: { session: null }, error }),
    signOut: async () => ({ error: null }),
  });
}

afterEach(() => vi.unstubAllGlobals());

test.each([
  { when: "the network dropped", error: new AuthRetryableFetchError("Failed to fetch", 0), out: 0 },
  { when: "auth answered 503", error: new AuthRetryableFetchError("Unavailable", 503), out: 0 },
  {
    when: "auth refused",
    error: new AuthApiError("Invalid Refresh Token", 400, undefined),
    out: 1,
  },
])("a 401, then $when: signs out $out times", async ({ error, out }) => {
  vi.stubGlobal("fetch", async () =>
    Response.json(
      { error: { code: "UNAUTHORIZED", message: "Sign in to continue" } },
      { status: 401 },
    ),
  );
  const onSessionDead = vi.fn();
  const api = createApiClient({
    baseUrl: "http://api.test",
    session: sessionWhoseRefresh(error),
    onSessionDead,
    refreshRetryDelayMs: 0,
  });

  await expect(api.get("/notes")).rejects.toMatchObject({ status: 401 });
  expect(onSessionDead).toHaveBeenCalledTimes(out);
});
```

[Supabase sessions](react/README.md#supabase-sessions).

### Retries

```ts
// apps/web/src/lib/queryClient.ts
import { queryDefaults } from "@gusnips/react";
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({ defaultOptions: queryDefaults() });
```

**Retry only what waiting can fix.** `queryDefaults` retries a timeout, a 429, a 5xx, and a request
that got no answer. Every other 4xx is an answer, and asking again gets the same answer. With
Supabase down, the API answered 503, and the notes request went out 3 times before the page showed
the error. A 429 that says it will not clear by waiting is not retried either.
[Never retry what waiting cannot fix](react/README.md#never-retry-what-waiting-cannot-fix).

### Who is signed in

```ts
// apps/web/src/stores/authStore.ts
import { createAuthStore } from "@gusnips/react/store";
import type { User } from "@supabase/supabase-js";
import { queryClient } from "../lib/queryClient.ts";
import { supabase } from "../services/supabase.ts";

export const useAuthStore = createAuthStore<User>();

// Call once, from main.tsx. Supabase reports the session a reload restores, a sign-in in
// another tab, each token refresh and a sign-out, and the store follows.
export function startSessionSync(): void {
  supabase.auth.onAuthStateChange((event, session) => {
    useAuthStore.getState().setUser(session?.user ?? null);
    if (event === "SIGNED_OUT") queryClient.clear();
  });
}
```

```tsx
// apps/web/src/components/guards.tsx
import { createRequireAnonymous, createRequireAuth } from "@gusnips/react/guards";
import { useAuthStore } from "../stores/authStore.ts";

const loading = <p className="p-8 text-muted-foreground">Loading…</p>;

export const RequireAuth = createRequireAuth(useAuthStore, "/sign-in", { loading });
export const RequireAnonymous = createRequireAnonymous(useAuthStore, "/notes", { loading });
```

```tsx
// apps/web/src/App.tsx
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { EmptyState } from "./components/EmptyState.tsx";
import { RequireAnonymous, RequireAuth } from "./components/guards.tsx";
import { SignInPage } from "./pages/SignInPage.tsx";

const NotesPage = lazy(() =>
  import("./pages/NotesPage.tsx").then((m) => ({ default: m.NotesPage })),
);

export function App() {
  return (
    <Suspense fallback={<p className="p-8">Loading…</p>}>
      <Routes>
        <Route path="/" element={<Navigate to="/notes" replace />} />
        <Route
          path="/sign-in"
          element={
            <RequireAnonymous>
              <SignInPage />
            </RequireAnonymous>
          }
        />
        <Route
          path="/notes"
          element={
            <RequireAuth>
              <NotesPage />
            </RequireAuth>
          }
        />
        <Route
          path="*"
          element={
            <EmptyState
              headingLevel={1}
              title="There is no page at this address"
              description="The link may be old, or the address may have a typo."
              action={<a href="/notes">Go to your notes</a>}
            />
          }
        />
      </Routes>
    </Suspense>
  );
}
```

A signed-out reader who opens `/notes?sort=new` lands on `/sign-in?next=%2Fnotes%3Fsort%3Dnew`.
After they sign in, `RequireAnonymous` checks that `next` is a page on this site and sends them
there.

**While the session is loading, a guard waits.** Supabase needs a moment to read the saved session
after a reload. Until then `isLoading` is true, and the guard shows `loading` rather than sending
a signed-in person to the sign-in page. `isLoading` starts true only in a browser, so a page
rendered at build time never gets saved as a spinner.

```tsx
// apps/web/src/components/guards.test.tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, expect, test } from "vitest";
import { useAuthStore } from "../stores/authStore.ts";
import { RequireAuth } from "./guards.tsx";

function Where() {
  const { pathname, search } = useLocation();
  return <p>at {pathname + search}</p>;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/sign-in" element={<Where />} />
        <Route
          path="/notes"
          element={
            <RequireAuth>
              <p>your notes</p>
            </RequireAuth>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true }));

test("waits while the session is still loading", () => {
  renderAt("/notes");
  expect(screen.getByText("Loading…")).toBeTruthy();
});

test("sends a signed-out reader to sign in, and remembers where they were going", () => {
  useAuthStore.getState().setUser(null);
  renderAt("/notes?sort=new");
  expect(screen.getByText("at /sign-in?next=%2Fnotes%3Fsort%3Dnew")).toBeTruthy();
});
```

The sign-in page makes the same outage-or-no call as the API:

```tsx
// apps/web/src/pages/SignInPage.tsx
import { isAuthOutage } from "@gusnips/react/supabase";
import { useState } from "react";
import { supabase } from "../services/supabase.ts";

export function SignInPage() {
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const { error } = await supabase.auth.signInWithPassword({
          email: String(form.get("email")),
          password: String(form.get("password")),
        });
        if (isAuthOutage(error)) setProblem("Sign-in is not answering. Try again in a moment.");
        else if (error)
          setProblem("That email and password don't match. Check both and try again.");
      }}
    >
      <input name="email" type="email" autoComplete="email" required />
      <input name="password" type="password" autoComplete="current-password" required />
      <button type="submit">Sign in</button>
      {problem && <p role="alert">{problem}</p>}
    </form>
  );
}
```

[Guards that can tell "no" from "I don't know"](react/README.md#guards-that-can-tell-no-from-i-dont-know).

### Errors and empty pages

The kit ships the props of an error panel and an empty panel, not the panels. You draw them.

```tsx
// apps/web/src/components/ErrorState.tsx
import type { ErrorStateProps } from "@gusnips/react";

export function ErrorState(props: ErrorStateProps) {
  const { problem, cause, fix, action, reference, headingLevel = 3 } = props;
  const Heading = `h${headingLevel}` as const;
  return (
    <div role="alert" className="rounded-lg border border-border bg-card p-6 text-card-foreground">
      <Heading className="font-semibold">{problem}</Heading>
      {cause && <p className="mt-1 text-muted-foreground">{cause}</p>}
      <p className="mt-1">{fix}</p>
      <div className="mt-4">{action}</div>
      {reference && <p className="mt-3 font-mono text-xs text-muted-foreground">{reference}</p>}
    </div>
  );
}
```

```tsx
// apps/web/src/components/EmptyState.tsx
import type { EmptyStateProps } from "@gusnips/react";

export function EmptyState({ title, description, action, headingLevel = 3 }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center">
      <Heading className="font-semibold">{title}</Heading>
      <p className="mt-1 text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
```

**`fix` and `action` are required.** Every error tells the reader what to do next, and gives them
a control to do it. A required prop is the one version of that rule a caller in a hurry cannot
skip.

Honour `headingLevel`. A panel sits under a page heading, so it defaults to `h3`. The "no page at
this address" screen in `App.tsx` passes `headingLevel={1}`, because that panel is the whole page,
and a page with no `h1` gives a screen reader nothing to announce.

The describer turns a thrown error into the words for that panel:

```ts
// apps/web/src/lib/describeError.ts
import { createErrorDescriber, type ErrorArm } from "@gusnips/react";
import type { ErrorCode } from "@notes/shared";

const codes: Partial<Record<ErrorCode, ErrorArm>> = {
  VALIDATION_ERROR: () => ({
    cause: "That can't be saved as it is.",
    fix: "Check it and try again.",
  }),
};

const inTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export const describeError = createErrorDescriber({
  // The words for failures that come with no sentence from the server.
  copy: {
    network: "We could not reach the server.",
    networkHint: "Check your connection, then try again.",
    unexpected: "Something went wrong on our side.",
    retrySoon: "Try again in a moment.",
  },
  formatWait: (secs) => inTime.format(secs, "second"),
  codes,
});
```

This app is in one language, so it writes those four sentences out. An app that translates
passes its `t` and its catalog instead; see
[the error describer](react/README.md#never-dead-end-anyone).

It returns `recover`: `"retry"`, `"wait"`, `"signin"` or `"none"`. That comes from the same rule
`queryDefaults` retries with, so the button never offers a retry the client has already given up
on:

```tsx
// apps/web/src/components/RecoverAction.tsx
import type { RecoveryKind } from "@gusnips/react";

// The control beside an error. `recover` comes from describeError, so the button only
// offers what can work.
export function RecoverAction({ recover, retry }: { recover: RecoveryKind; retry: () => void }) {
  if (recover === "signin") return <a href="/sign-in">Sign in again</a>;
  if (recover === "none") return <a href="mailto:help@example.com">Write to us</a>;
  return (
    <button type="button" onClick={retry} disabled={recover === "wait"}>
      Try again
    </button>
  );
}
```

The notes page puts it all together. `NewNote`, lower in the same file, is a form that calls
`api.post<Note>("/notes", { title })` and shows `describeError(add.error)` under it.

```tsx
// apps/web/src/pages/NotesPage.tsx
import { queryView } from "@gusnips/react";
import type { Note } from "@notes/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../services/api.ts";
import { describeError } from "../lib/describeError.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { ErrorState } from "../components/ErrorState.tsx";
import { RecoverAction } from "../components/RecoverAction.tsx";

export function NotesPage() {
  const notes = useQuery({ queryKey: ["notes"], queryFn: () => api.get<Note[]>("/notes") });
  const view = queryView(notes);

  if (view.state === "waiting") return <p>Loading your notes…</p>;

  if (view.state === "failed") {
    const { cause, fix, recover, reference } = describeError(view.error);
    return (
      <ErrorState
        problem="We couldn't load your notes"
        cause={cause}
        fix={fix ?? "Reload the page. If it keeps happening, write to us."}
        action={<RecoverAction recover={recover} retry={() => void notes.refetch()} />}
        reference={reference}
      />
    );
  }

  if (view.data.length === 0) {
    return (
      <EmptyState
        title="No notes yet"
        description="Notes you write show up here, newest first."
        action={<NewNote />}
      />
    );
  }

  return (
    <>
      <NewNote />
      <ul>
        {view.data.map((note) => (
          <li key={note.id}>{note.title}</li>
        ))}
      </ul>
    </>
  );
}
```

With Supabase down, the page read this after its three tries. The last line is the button:

```text
We couldn't load your notes
Sign-in is not answering right now
Try again in a moment.
[Try again]
```

with the request id under it, for the reader to quote if they write to you. A title of two spaces
showed "That can't be saved as it is. Check it and try again."

**Use `queryView`, not `isError`.** `isError` is also true when a background refresh fails while
the list is already on screen. `isError ? <Error /> : <List />` then swaps a working page for an
error over one dropped request. `queryView` shows the error only when there is nothing else to
show.
[A failed refresh is not a failed page](react/README.md#a-failed-refresh-is-not-a-failed-page),
[never dead-end anyone](react/README.md#never-dead-end-anyone).

### Deploys and crashes

```tsx
// apps/web/src/main.tsx
import {
  ErrorBoundary,
  installPreloadErrorHandler,
  isChunkLoadError,
  reloadOnce,
} from "@gusnips/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { startSessionSync } from "./stores/authStore.ts";
import { CrashScreen } from "./components/CrashScreen.tsx";
import { queryClient } from "./lib/queryClient.ts";
import "./index.css";

installPreloadErrorHandler();
startSessionSync();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary
      isChunkError={isChunkLoadError}
      fallback={({ isChunkError, reset }) =>
        isChunkError && reloadOnce() ? null : <CrashScreen onRetry={reset} />
      }
    >
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
```

```tsx
// apps/web/src/components/CrashScreen.tsx
// Drawn by the ErrorBoundary in main.tsx, outside the router, so links here are plain <a>.
export function CrashScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="p-8">
      <h1 className="text-xl font-semibold">This page stopped working</h1>
      <p className="mt-2">Something in the app broke while drawing this screen.</p>
      <p className="mt-2">Try again. If that does not help, go back to your notes.</p>
      <div className="mt-4 flex gap-4">
        <button type="button" onClick={onRetry}>
          Try again
        </button>
        <a href="/notes">Back to your notes</a>
      </div>
    </main>
  );
}
```

**A deploy deletes the files an open tab still needs.** The notes page is a separate file with a
hash in its name. Deploy while someone has the app open, and their next click asks for a file that
is gone. `reloadOnce` reloads the page to pick up the new files, and at most once a minute, so a
file that is really missing cannot reload the page forever. We removed that file under an open tab:
the tab reloaded once, then showed the crash screen.

`ErrorBoundary` wraps the whole app, so a crash anywhere below it draws `CrashScreen` instead of a
white page. It sits outside the router, which is why the crash screen's links are plain `<a>`.

`installPreloadErrorHandler` covers one more case: Vite's CSS preload hint failing, which is
harmless, so it is ignored.

Fix your host too. A static host answers a missing `/assets/x.js` with your `index.html`, at status
200, and `vite preview` does the same. Answer a miss under `/assets/` with a real 404, and never
cache it. [Survives your deploys](react/README.md#survives-your-deploys).

## Run it

Start Postgres. Then, from `apps/api`:

```bash
bun run migrate
bun run dev
```

And from `apps/web`, in a second terminal:

```bash
bun run dev
```

The API answers on port 3000 and the web app on port 5173. To check the whole repo, run this from
the root:

```bash
bunx turbo run typecheck test build
```

It runs six tasks: the three typechecks, the two test suites, and the web build.

## What's next

[Part 2](GUIDE-2.md) covers these, one chapter each:

- [Pages a search engine can read](GUIDE-2.md#pages-a-search-engine-can-read): prerendering, the
  sitemap and share cards.
- [More than one language](GUIDE-2.md#more-than-one-language): addresses per language, the
  language gate, and checking your translations.
- [Redis and background jobs](GUIDE-2.md#redis-and-background-jobs): a queue the API fills and a
  worker empties, and jobs that are safe to run twice.
- [Sending mail](GUIDE-2.md#sending-mail): a mail that goes out once, in the reader's language,
  with a link that stops it.
- [Webhooks, in and out](GUIDE-2.md#webhooks-in-and-out): calling a user's server when an import
  is done, trying again, and checking one you receive.
- [An OpenAPI reference](GUIDE-2.md#an-openapi-reference): one file that lists every route, built
  from the schemas the routes check. An SDK built from it comes later:
  [@gusnips/sdkgen](sdkgen/README.md).
- [A public API](GUIDE-2.md#a-public-api): keys a user's own code sends, a limit on how many
  requests each user sends in a minute, and an MCP door for AI agents.
