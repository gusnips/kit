import {
  AuthApiError,
  AuthImplicitGrantRedirectError,
  AuthPKCEGrantCodeExchangeError,
  AuthRefreshDiscardedError,
  AuthRetryableFetchError,
  AuthUnknownError,
  createClient,
} from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGN_OUT_TIMEOUT_MS } from "./api-client.ts";
import {
  createSupabaseSessionAdapter,
  isAuthOutage,
  parseAuthCallback,
  signOutEvenOffline,
  signOutOtherDevices,
  supabaseAuthStorage,
  supabaseStorageKey,
  type SupabaseSessionAuth,
  type SupabaseSessionStorage,
} from "./supabase-session.ts";

function auth(overrides: Partial<SupabaseSessionAuth> = {}): SupabaseSessionAuth {
  return {
    getSession: async () => ({ data: { session: { access_token: "old-token" } } }),
    refreshSession: async () => ({
      data: { session: { access_token: "new-token" } },
      error: null,
    }),
    signOut: async () => ({ error: null }),
    ...overrides,
  };
}

// The real auth-js this package installs, against a network that is down. A stub would only
// repeat what this file believes auth-js does, and the whole bug is that it does something else.
const PROJECT_URL = "https://abcdefghijklmnop.supabase.co";
const now = (): number => Math.floor(Date.now() / 1000);
const base64Url = (value: object): string =>
  btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function storedSession(expiresAt: number) {
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    aud: "authenticated",
    role: "authenticated",
    email: "someone@example.test",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
  const claims = { sub: user.id, exp: expiresAt, aud: "authenticated", role: "authenticated" };
  return {
    access_token: `${base64Url({ alg: "HS256", typ: "JWT" })}.${base64Url(claims)}.signature`,
    refresh_token: `refresh-${expiresAt}`,
    token_type: "bearer",
    expires_in: expiresAt - now(),
    expires_at: expiresAt,
    user,
  };
}

function memoryStorage(): SupabaseSessionStorage["storage"] {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

const unreachable: typeof fetch = async () => {
  throw new TypeError("fetch failed");
};

/** `paths` collects each request's path and query, so a test can read the scope `/logout` got. */
function reachable(paths: string[] = []): typeof fetch {
  return async (input) => {
    const { pathname, search } = new URL(input instanceof Request ? input.url : input);
    paths.push(pathname + search);
    if (pathname.endsWith("/token")) return Response.json(storedSession(now() + 3600));
    if (pathname.endsWith("/logout")) return new Response(null, { status: 204 });
    return Response.json({ msg: "not part of this test" }, { status: 404 });
  };
}

function authClient(stored: SupabaseSessionStorage, fetch: typeof globalThis.fetch) {
  return createClient(PROJECT_URL, "anon-key", {
    // Off so that starting the client does not refresh an expired session by itself: the refresh
    // under test is the one `signOut()` makes.
    auth: { ...stored, autoRefreshToken: false },
    global: { fetch },
  }).auth;
}

async function signedIn(
  expiresAt: number,
  fetch = unreachable,
  stored: SupabaseSessionStorage = {
    storage: memoryStorage(),
    storageKey: supabaseStorageKey(PROJECT_URL),
  },
) {
  await stored.storage.setItem(stored.storageKey, JSON.stringify(storedSession(expiresAt)));
  const auth = authClient(stored, fetch);
  const events: string[] = [];
  auth.onAuthStateChange((event) => {
    events.push(event);
  });
  await auth.initialize();
  return { stored, auth, signedOut: () => events.filter((e) => e === "SIGNED_OUT").length };
}

/** What a reload reads: a new client on the same storage, with the network back. */
async function sessionAfterReload(stored: SupabaseSessionStorage) {
  const { data } = await authClient(stored, reachable()).getSession();
  return data.session;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSupabaseSessionAdapter", () => {
  it("reads the current token and the refreshed token", async () => {
    const adapter = createSupabaseSessionAdapter(auth());

    await expect(adapter.getToken()).resolves.toBe("old-token");
    await expect(adapter.refresh()).resolves.toEqual({
      token: "new-token",
      reachedAuth: true,
    });
  });

  it("shares one refresh between callers that overlap, then refreshes again", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const adapter = createSupabaseSessionAdapter(
      auth({
        refreshSession: async () => {
          calls += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { data: { session: { access_token: `token-${calls}` } }, error: null };
        },
      }),
    );

    // The API client and a hand-opened stream asking at the same moment.
    const first = adapter.refresh();
    const second = adapter.refresh();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { token: "token-1", reachedAuth: true },
      { token: "token-1", reachedAuth: true },
    ]);
    expect(calls).toBe(1);

    const later = adapter.refresh();
    release();
    await expect(later).resolves.toEqual({ token: "token-2", reachedAuth: true });
    expect(calls).toBe(2);
  });

  it("keeps the session when a refresh never reached auth", async () => {
    const retryable = new AuthRetryableFetchError("offline", 0);
    const returned = createSupabaseSessionAdapter(
      auth({
        refreshSession: async () => ({ data: { session: null }, error: retryable }),
      }),
    );
    const thrown = createSupabaseSessionAdapter(
      auth({
        refreshSession: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );

    await expect(returned.refresh()).resolves.toEqual({ token: null, reachedAuth: false });
    await expect(thrown.refresh()).resolves.toEqual({ token: null, reachedAuth: false });
  });

  it("marks a terminal auth refusal whether it is returned or thrown", async () => {
    const refusal = new AuthApiError("expired", 401, "refresh_token_not_found");
    const returned = createSupabaseSessionAdapter(
      auth({
        refreshSession: async () => ({ data: { session: null }, error: refusal }),
      }),
    );
    const thrown = createSupabaseSessionAdapter(
      auth({
        refreshSession: async () => {
          throw refusal;
        },
      }),
    );

    await expect(returned.refresh()).resolves.toEqual({ token: null, reachedAuth: true });
    await expect(thrown.refresh()).resolves.toEqual({ token: null, reachedAuth: true });
  });

  it("keeps the session when auth answers with a failure of its own", async () => {
    // `isAuthRetryableFetchError` says false for this one — it is an API error, not a fetch
    // failure — so what holds the session is the status clause beside it. A 5xx is auth
    // failing, never auth answering, and reading it as an answer signs the person out.
    const outage = new AuthApiError("Internal Server Error", 500, undefined);
    const adapter = createSupabaseSessionAdapter(
      auth({
        refreshSession: async () => ({ data: { session: null }, error: outage }),
      }),
    );

    await expect(adapter.refresh()).resolves.toEqual({ token: null, reachedAuth: false });
  });

  it("does not kill a session whose rotated refresh was discarded after a local race", async () => {
    const adapter = createSupabaseSessionAdapter(
      auth({
        refreshSession: async () => ({
          data: { session: null },
          error: new AuthRefreshDiscardedError(),
        }),
      }),
    );

    await expect(adapter.refresh()).resolves.toEqual({ token: null, reachedAuth: false });
  });

  it("turns a resolved sign-out error into a rejection", async () => {
    const refusal = new AuthApiError("unavailable", 503, "unexpected_failure");
    const signOut = vi.fn(async () => ({ error: refusal }));
    const adapter = createSupabaseSessionAdapter(auth({ signOut }));

    await expect(adapter.signOut()).rejects.toBe(refusal);
    // This device only: a token one device's API refused says nothing about the others.
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });

  it("with `stored`, rejects when auth never heard it, but the session has left", async () => {
    vi.useFakeTimers();
    const { stored, auth } = await signedIn(now() - 60);
    const adapter = createSupabaseSessionAdapter(auth, stored);

    const rejected = expect(adapter.signOut()).rejects.toMatchObject({
      message: expect.stringContaining(`${SIGN_OUT_TIMEOUT_MS} ms`),
    });
    await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS);
    await rejected;

    expect(await stored.storage.getItem(stored.storageKey)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
  });
});

describe("signOutEvenOffline", () => {
  it("is needed: signOut() alone keeps an expired session when auth is unreachable", async () => {
    // The positive control for every test below: the reload check can see a live session.
    vi.useFakeTimers();
    const { stored, auth, signedOut } = await signedIn(now() - 60);

    const signingOut = auth.signOut();
    // auth-js retries the refresh with a backoff it gives up on inside 30 s.
    await vi.advanceTimersByTimeAsync(60_000);
    const { error } = await signingOut;

    expect(error).toBeInstanceOf(AuthRetryableFetchError);
    expect(signedOut()).toBe(0);
    vi.useRealTimers();
    expect(await sessionAfterReload(stored)).not.toBeNull();
  });

  it("removes an expired session within the deadline when auth cannot be reached", async () => {
    vi.useFakeTimers();
    const { stored, auth, signedOut } = await signedIn(now() - 60);

    const signingOut = signOutEvenOffline(auth, stored);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS);
    const { error } = await signingOut;

    // auth-js is still in its refresh backoff, so it is the deadline that answered.
    expect(error).toMatchObject({ message: expect.stringContaining(`${SIGN_OUT_TIMEOUT_MS} ms`) });
    expect(await stored.storage.getItem(stored.storageKey)).toBeNull();
    // SIGNED_OUT comes from the local sign-out, once auth-js is done with the first call.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signedOut()).toBe(1);
    vi.useRealTimers();
    expect(await sessionAfterReload(stored)).toBeNull();
  });

  it("removes a valid session when /logout gets no answer, and says SIGNED_OUT once", async () => {
    // The installed auth-js removes this one itself and still returns the error, so this is the
    // branch that must not remove it a second time: that would send SIGNED_OUT twice.
    const { stored, auth, signedOut } = await signedIn(now() + 3600);

    const { error } = await signOutEvenOffline(auth, stored);
    // A second sign-out would not be awaited, so give it the time to speak before counting.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(error).toBeInstanceOf(AuthRetryableFetchError);
    expect(await stored.storage.getItem(stored.storageKey)).toBeNull();
    expect(signedOut()).toBe(1);
    expect(await sessionAfterReload(stored)).toBeNull();
  });

  it("ends this device's session on the server too when auth answers, and no other", async () => {
    const paths: string[] = [];
    const { stored, auth, signedOut } = await signedIn(now() + 3600, reachable(paths));

    const { error } = await signOutEvenOffline(auth, stored);

    expect(error).toBeNull();
    // auth-js's default, scope=global, would end the person's sessions on every device.
    expect(paths).toContain("/auth/v1/logout?scope=local");
    expect(signedOut()).toBe(1);
    expect(await sessionAfterReload(stored)).toBeNull();
  });
});

describe("signOutOtherDevices", () => {
  it("ends the other sessions and keeps this one", async () => {
    const paths: string[] = [];
    const { stored, auth, signedOut } = await signedIn(now() + 3600, reachable(paths));

    const { error } = await signOutOtherDevices(auth);

    expect(error).toBeNull();
    expect(paths).toContain("/auth/v1/logout?scope=others");
    expect(signedOut()).toBe(0);
    expect(await sessionAfterReload(stored)).not.toBeNull();
  });

  it("keeps this device signed in and says why when auth cannot be reached", async () => {
    const { stored, auth, signedOut } = await signedIn(now() + 3600);

    const { error } = await signOutOtherDevices(auth);

    expect(error).toBeInstanceOf(AuthRetryableFetchError);
    expect(signedOut()).toBe(0);
    expect(await sessionAfterReload(stored)).not.toBeNull();
  });

  it("gives up at the deadline instead of waiting out the refresh backoff", async () => {
    vi.useFakeTimers();
    const { stored, auth } = await signedIn(now() - 60);

    const signingOut = signOutOtherDevices(auth);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS);
    const { error } = await signingOut;

    expect(error).toMatchObject({ message: expect.stringContaining(`${SIGN_OUT_TIMEOUT_MS} ms`) });
    expect(await stored.storage.getItem(stored.storageKey)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
  });
});

describe("supabaseStorageKey", () => {
  it("names the key supabase-js picks when you set none", async () => {
    const storage = memoryStorage();
    await storage.setItem(
      supabaseStorageKey(PROJECT_URL),
      JSON.stringify(storedSession(now() + 3600)),
    );
    const auth = createClient(PROJECT_URL, "anon-key", {
      auth: { storage, autoRefreshToken: false },
      global: { fetch: unreachable },
    }).auth;

    const { data } = await auth.getSession();

    expect(data.session).not.toBeNull();
  });
});

describe("supabaseAuthStorage", () => {
  // Stubs for a browser's globals. The tests run in Node, which has none of them; the real
  // browser is in supabase-session.browser.test.ts.
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  function inBrowser(localStorage: PropertyDescriptor) {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    Object.defineProperty(globalThis, "localStorage", { configurable: true, ...localStorage });
  }

  it("keeps the session in memory in a prerender, instead of throwing", async () => {
    const { storage } = supabaseAuthStorage(PROJECT_URL);

    await storage.setItem("key", "value");
    expect(await storage.getItem("key")).toBe("value");
    await storage.removeItem("key");
    expect(await storage.getItem("key")).toBeNull();
  });

  it("keeps it in memory when a browser blocks storage, instead of a blank page", () => {
    inBrowser({
      get: () => {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });

    expect(() => supabaseAuthStorage(PROJECT_URL)).not.toThrow();
  });

  it("signs out of the store in memory too, when auth cannot be reached", async () => {
    vi.useFakeTimers();
    const { stored, auth } = await signedIn(
      now() - 60,
      unreachable,
      supabaseAuthStorage(PROJECT_URL),
    );
    expect(await stored.storage.getItem(stored.storageKey)).not.toBeNull();

    const signingOut = signOutEvenOffline(auth, stored);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS);
    await signingOut;

    expect(await stored.storage.getItem(stored.storageKey)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    expect(await sessionAfterReload(stored)).toBeNull();
  });

  it("does not take a localStorage that is not a browser's, as supabase-js does not", () => {
    const local = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });

    expect(supabaseAuthStorage(PROJECT_URL).storage).not.toBe(local);
  });
});

describe("isAuthOutage", () => {
  it("lets a real refusal through as an answer", () => {
    expect(
      isAuthOutage(new AuthApiError("Invalid login credentials", 400, "invalid_credentials")),
    ).toBe(false);
    expect(
      isAuthOutage(new AuthApiError("Token has expired or is invalid", 403, "otp_expired")),
    ).toBe(false);
  });

  it("refuses to read a failure as an answer", () => {
    // Nothing came back, and the two shapes that carries.
    expect(isAuthOutage(new AuthRetryableFetchError("Failed to fetch", 0))).toBe(true);
    expect(isAuthOutage(new TypeError("Load failed"))).toBe(true);
    // A gateway between us and GoTrue, which auth-js wraps by name.
    expect(isAuthOutage(new AuthRetryableFetchError("Bad Gateway", 502))).toBe(true);
    // And the reason the status clause is not redundant: the statuses earning that name are a
    // LIST, so it has holes at every version. 507 and 599 are on no version of it, and with a
    // JSON body arrive as ordinary AuthApiErrors that `isAuthRetryableFetchError` answers false
    // for. (With a body that is not JSON they arrive with no status at all: see below.)
    expect(isAuthOutage(new AuthApiError("Insufficient Storage", 507, undefined))).toBe(true);
    expect(isAuthOutage(new AuthApiError("Network Connect Timeout", 599, undefined))).toBe(true);
  });

  it("reads auth-js's own callback URL errors as answers, despite their 500", () => {
    // Built by auth-js itself while it reads a sign-in's callback URL, with 500 written into the
    // class. The URL said the person denied consent, the link is spent, or there is no code: a
    // retry re-reads the same URL, so "try again" there is a dead end.
    const denied = new AuthImplicitGrantRedirectError("access_denied", {
      error: "access_denied",
      code: "access_denied",
    });
    const noCode = new AuthPKCEGrantCodeExchangeError("No code detected.");
    expect([denied.status, noCode.status]).toEqual([500, 500]);
    expect(isAuthOutage(denied)).toBe(false);
    expect(isAuthOutage(noCode)).toBe(false);
  });

  it("gives an error from outside auth-js the benefit of the doubt", () => {
    // auth-js returns its refusals, so this only ever arrives from a `catch`: something under the
    // call broke, and nothing was said about the session. On a client that decides whether to sign
    // someone out, the doubt keeps them signed in. The server copy answers false on purpose.
    expect(isAuthOutage(new Error("storage is locked"))).toBe(true);
  });

  it("reads nothing-went-wrong as nothing went wrong", () => {
    // `null` is the SUCCESS value of every supabase-js auth call, and this function is
    // exported, so the obvious `if (isAuthOutage(error))` around a `getUser()` result has to
    // be safe. Before this, it answered true and put an outage on screen over every success.
    // One adopter had already written the guard at its own call site, which is what a missing
    // check in here looks like from the outside.
    expect(isAuthOutage(null)).toBe(false);
    expect(isAuthOutage(undefined)).toBe(false);
  });

  it("stays narrow for an error auth-js could not read", () => {
    // AuthUnknownError is raised whenever the body does not parse as JSON, at ANY status, and
    // it never fills one in — but `status` is still PRESENT, because the base class declares
    // it, so `"status" in error` answers true and says nothing. That makes a 507 behind an
    // HTML-answering proxy indistinguishable from a malformed 400, and the narrow answer is
    // the right one: widening by class name would call the malformed 400 an outage too, and a
    // dead session read as retryable is the same failure from the other side.
    const unreadable = new AuthUnknownError("Unexpected token < in JSON", new Error("parse"));
    expect(unreadable.status).toBeUndefined();
    expect(isAuthOutage(unreadable)).toBe(false);
  });
});

describe("parseAuthCallback", () => {
  it("reads an email link, including the types an app's templates may not send yet", () => {
    expect(parseAuthCallback("?token_hash=pkce_abc&type=recovery")).toEqual({
      kind: "email-link",
      tokenHash: "pkce_abc",
      type: "recovery",
    });
    // An operator can invite from Studio whatever the product does; rejecting the type put
    // "invalid link" on a real, branded invitation.
    expect(parseAuthCallback(new URLSearchParams("token_hash=abc&type=invite"))).toMatchObject({
      kind: "email-link",
      type: "invite",
    });
  });

  it("refuses an email link whose type is missing or made up", () => {
    expect(parseAuthCallback("?token_hash=abc")).toEqual({ kind: "invalid" });
    expect(parseAuthCallback("?token_hash=abc&type=admin")).toEqual({ kind: "invalid" });
    // A key every object inherits is still not a link type.
    expect(parseAuthCallback("?token_hash=abc&type=toString")).toEqual({ kind: "invalid" });
    expect(parseAuthCallback("", "")).toEqual({ kind: "invalid" });
  });

  it("hands back the session a URL carries, in either flow", () => {
    expect(parseAuthCallback("?code=4f1c")).toEqual({
      kind: "session",
      type: null,
      credential: { code: "4f1c" },
    });
    // The implicit flow puts the tokens, and a recovery's type, in the fragment.
    expect(
      parseAuthCallback("", "#access_token=at&expires_in=3600&refresh_token=rt&type=recovery"),
    ).toEqual({
      kind: "session",
      type: "recovery",
      credential: { access_token: "at", refresh_token: "rt" },
    });
    expect(parseAuthCallback("", "#access_token=at")).toEqual({ kind: "invalid" });
  });

  it("tells a person who pressed Cancel from a link that expired", () => {
    // A refusal relayed from the provider: GoTrue writes it to both halves, with no code.
    const cancel = "error=access_denied&error_description=The+user+denied+the+request";
    expect(parseAuthCallback(`?${cancel}`, `#${cancel}&sb=`)).toEqual({
      kind: "error",
      error: "access_denied",
      code: null,
      cancelled: true,
    });
    // GoTrue's own refusal of an implicit-flow email link: the SAME error, a code beside it,
    // and only in the fragment — a query-only reader sees nothing at all.
    expect(
      parseAuthCallback(
        "",
        "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=",
      ),
    ).toEqual({ kind: "error", error: "access_denied", code: "otp_expired", cancelled: false });
  });

  it("reads a failure that carries no `error` at all", () => {
    // Statuses outside GoTrue's OAuth mapping, a 429 among them, write only the code.
    expect(
      parseAuthCallback("", "#error_code=over_email_send_rate_limit&error_description=x&sb="),
    ).toEqual({ kind: "error", error: null, code: "over_email_send_rate_limit", cancelled: false });
  });
});
