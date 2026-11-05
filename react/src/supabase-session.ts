import {
  isAuthError,
  isAuthRetryableFetchError,
  type SignOut,
  type SupabaseClient,
  type SupabaseClientOptions,
  type SupportedStorage,
} from "@supabase/supabase-js";
import { SIGN_OUT_TIMEOUT_MS, type SessionAdapter } from "./api-client.ts";

interface SupabaseSessionResult {
  data: { session: { access_token: string } | null };
}

/** The three auth calls the API client needs, kept structural so any Supabase schema fits. */
export interface SupabaseSessionAuth {
  getSession(): Promise<SupabaseSessionResult>;
  refreshSession(): Promise<SupabaseSessionResult & { error: unknown }>;
  signOut(options?: SignOut): Promise<{ error: unknown }>;
  /** supabase-js always has it. {@link signOutEvenOffline} listens with it so it never sends a
   *  second `SIGNED_OUT`; without it, that cleanup runs every time. */
  onAuthStateChange?(callback: (event: string) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
}

/**
 * Where auth-js keeps the session: the two `createClient` options it reads it from. Build the
 * object once and pass it both as `createClient`'s `auth` and to {@link signOutEvenOffline}, so
 * the key the helper clears is the key auth-js writes because they are one value, not because
 * two copies happen to agree. A wrong key would read as "auth-js already removed it", and the
 * session would stay.
 */
export interface SupabaseSessionStorage {
  storage: SupportedStorage;
  storageKey: string;
}

type Satisfied<T extends true> = T;
type _SupabaseAuthFitsAdapter = Satisfied<
  SupabaseClient["auth"] extends SupabaseSessionAuth ? true : false
>;
type _StorageFitsCreateClient = Satisfied<
  SupabaseSessionStorage extends NonNullable<SupabaseClientOptions<"public">["auth"]> ? true : false
>;

/**
 * Auth FAILED rather than answered, so nothing is known about the credential it was handed:
 * either the request never landed, or GoTrue failed on its own.
 *
 * This is the question every site that ends a session has to ask: a token refresh, an API door, and
 * a callback choosing between "try again" and "that link is spent". Without it one bad minute at
 * GoTrue signs out everybody whose token happened to need refreshing, and tells everybody clicking
 * a recovery link that it has expired, which sends them to ask the service that is down for a
 * replacement.
 *
 * Both clauses carry weight, and the second is why this is a function rather than one call.
 * `isAuthRetryableFetchError` is a NAME check, and the statuses that earn that name are a list
 * auth-js owns. The list has drifted: 502, 503 and 504 at 2.91; those plus the 52x family and still
 * no 500 at 2.106; 500 through 530 at 2.108. Code leaning on it alone is right at whichever version
 * happens to be installed, which is not the same as being right, and a fleet installs several
 * versions at once. It is also a LIST rather than a range, so it has holes at every version, drift
 * or no drift: at 2.112 nothing covers 505 through 519 or 531 up, and a 507 or a 599 with a JSON
 * body arrives as a plain `AuthApiError`. Pinning a recent SDK does not make the status clause
 * redundant.
 *
 * The same statuses with a body that is NOT JSON, such as a proxy's HTML page, arrive as an
 * `AuthUnknownError`, which carries no status at any status, so nothing here can tell that 507 from
 * a malformed 400. It answers false for both, on purpose: reading an unreadable 4xx as an outage
 * would leave a dead session retrying forever, which is the other half of the same bug.
 *
 * Read the version a tree really serves with `bun why @supabase/auth-js`, which prints one
 * heading per RESOLVED version; `node_modules` keeps copies the resolver does not serve.
 *
 * Anything that is not an auth error at all answers true: a failure from outside auth-js is not a
 * verdict on the credential either. Nothing at all answers false. `null` is what every supabase-js
 * auth call returns on success, and success is not an outage.
 */
export function isAuthOutage(error: unknown): boolean {
  // Nothing thrown is not an outage, and this clause exists because the function is exported.
  // `null` is the SUCCESS value of every supabase-js auth call, so the obvious
  // `if (isAuthOutage(error))` around a `getUser()` result has to be safe; without this it read
  // every success as auth being down. An adopter had already written that guard at its own call
  // site, which is what a check missing from in here looks like from the outside.
  if (error == null) return false;
  if (!isAuthError(error)) return true;
  return isAuthRetryableFetchError(error) || (error.status ?? 0) >= 500;
}

function reachedAuth(error: unknown): boolean {
  // Measured across the fleet: four backends answered 401 to their own auth provider's 500,
  // and every client reads a 401 as a dead session, so one bad minute at auth signed out
  // everybody who was signed in. `isAuthError` leads only for the narrowing below —
  // `isAuthOutage` already answers true for anything that is not an auth error.
  if (!isAuthError(error) || isAuthOutage(error)) return false;
  // Newer clients name a refresh that reached GoTrue but was deliberately discarded because the
  // local session changed mid-flight. That race is a no-op, not proof that either session died.
  return error.name !== "AuthRefreshDiscardedError";
}

/**
 * supabase-js's default storage key: `sb-`, the first label of the project's host name, and
 * `-auth-token`. Set it as `storageKey` yourself rather than leaving it to the default. The value
 * is the same, so nobody who is signed in gets signed out by the change, and the key no longer
 * depends on supabase-js working it out the same way in the next version.
 */
export function supabaseStorageKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

/**
 * The `{ storage, storageKey }` supabase-js builds for itself when you pass neither: localStorage
 * if it takes a write, a store in memory if not, under {@link supabaseStorageKey}. Pass it to
 * `createClient`'s `auth` and to {@link signOutEvenOffline}. Nobody signed in today is signed out
 * by the change.
 *
 * A function, not `{ storage: localStorage, … }`, because that object is built at module scope,
 * and reading `localStorage` there throws in two places. A prerender under bun has none, so the
 * build fails. A browser that blocks storage raises a SecurityError, so the page is blank.
 * supabase-js keeps the session in memory in both, and so does this. On React Native, build the
 * object yourself with your `AsyncStorage`.
 */
export function supabaseAuthStorage(supabaseUrl: string): SupabaseSessionStorage {
  return { storage: localStorageOrMemory(), storageKey: supabaseStorageKey(supabaseUrl) };
}

function localStorageOrMemory(): SupportedStorage {
  // auth-js's own two questions: is this a browser, and does a write succeed. A Node with a
  // `localStorage` of its own is not a browser, and auth-js keeps that session in memory too.
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try {
      const { localStorage } = globalThis;
      localStorage.setItem("sb-storage-probe", "1");
      localStorage.removeItem("sb-storage-probe");
      return localStorage;
    } catch {
      // Blocked: memory, below.
    }
  }
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

/**
 * Signs out, and makes sure the session leaves this device even when auth cannot be reached.
 *
 * `auth.signOut()` alone does not. In two cases it resolves `{ error }` and keeps the stored
 * session. Both were measured on nine auth-js versions from 2.106.2 to 2.117.2; run
 * `bun why @supabase/auth-js` to see which one you have:
 *
 * - The access token has expired, or is close enough to expiring that auth-js refreshes it
 *   first, and the network is down. The refresh fails and `signOut()` returns that error before
 *   it touches storage. This happens at every version, and it is the common case: a laptop that
 *   wakes up offline with a tab still open.
 * - Before 2.110.2, the token is still good but `/logout` gets no answer. `signOut()` returns
 *   before it removes anything.
 *
 * Either way a reload reads the session and signs the person back in. On a shared computer, that
 * person is whoever sits down next. A screen that says "signed out" at that point is wrong.
 *
 * It ends this device's session and no other: `signOut({ scope: "local" })`, which fails in both
 * cases above too, because it calls `/logout` as well. auth-js's default is `"global"`, which ends
 * every session the person has. Signing out of a laptop then signed them out of their phone, and a
 * tab left open anywhere failed its next refresh with "Invalid Refresh Token: Refresh Token Not
 * Found". To end the other sessions on purpose, use {@link signOutOtherDevices}.
 *
 * Removing the key yourself is not enough on its own: nothing tells your `onAuthStateChange`
 * listeners or your other tabs, and auth-js's PKCE verifiers stay behind. So after removing it,
 * this calls `signOut({ scope: "local" })`. That call finds no session, skips `/logout`, and runs
 * auth-js's own cleanup: every key it owns, and one `SIGNED_OUT` to every listener.
 *
 * It waits on auth for {@link SIGN_OUT_TIMEOUT_MS} at most. Offline with an expired token,
 * `signOut()` first sits in auth-js's refresh backoff, which measured 15 s at 2.108.2 through
 * 2.116.0 and 41–51 s at 2.106.2. Nobody at a shared computer waits that long, and a page that
 * navigates away in the meantime takes the removal with it.
 *
 * It resolves once the stored session is gone. `error` is `null` when auth ended the session on the
 * server too. Otherwise it is the reason auth did not: its error, a thrown value or the deadline.
 * The session may still be live on the server. `SIGNED_OUT` arrives once
 * auth-js has finished with the first call: about 100 ms later from 2.108.2 on, and up to 22 s
 * later at 2.106.2. If your screen does not reload, clear your own store when this resolves instead
 * of waiting for the event.
 */
export async function signOutEvenOffline(
  auth: Pick<SupabaseSessionAuth, "signOut" | "onAuthStateChange">,
  { storage, storageKey }: SupabaseSessionStorage,
): Promise<{ error: unknown }> {
  // From 2.119.0 on, auth-js signs this device out by itself when a local sign-out meets a refresh
  // that could not reach auth, and sends SIGNED_OUT when its backoff ends. The cleanup below would
  // send it a second time, so it runs only if auth-js finished without sending one.
  let announced = false;
  const listening = auth.onAuthStateChange?.((event) => {
    if (event === "SIGNED_OUT") announced = true;
  });
  const done = () => listening?.data.subscription.unsubscribe();
  const first = auth.signOut({ scope: "local" }).catch((thrown: unknown) => ({ error: thrown }));
  const { error } = await withinSignOutDeadline(first);
  if (error == null) {
    done();
    return { error: null };
  }
  // From 2.110.2 on, auth-js has already removed the session when only `/logout` failed, and has
  // already sent SIGNED_OUT. Going on would send it a second time.
  if ((await storage.getItem(storageKey)) === null) {
    done();
    return { error };
  }
  await storage.removeItem(storageKey);
  // Not awaited: the first call may still be in auth-js's refresh backoff, and a second one would
  // wait behind it anyway. The session is already out of storage, and storage is what a reload reads.
  void first
    .then(async () => {
      if (!announced) await auth.signOut({ scope: "local" });
    })
    .catch(() => {})
    .finally(done);
  return { error };
}

/**
 * Ends the person's sessions on every other device and keeps this one signed in. For a "sign out
 * of other devices" button in account settings: a phone that was lost, a computer left signed in.
 *
 * It resolves `{ error: null }` once auth has ended the other sessions. Otherwise `error` says why
 * it did not: auth's error, a thrown value, or the deadline. This device is untouched either way,
 * so the person is still signed in and can press the button again.
 *
 * Like {@link signOutEvenOffline}, it waits on auth for {@link SIGN_OUT_TIMEOUT_MS} at most, because
 * offline with an expired token auth-js first sits in its refresh backoff. A deadline does not
 * prove the other sessions are still live: auth may end them after this gave up.
 */
export function signOutOtherDevices(
  auth: Pick<SupabaseSessionAuth, "signOut">,
): Promise<{ error: unknown }> {
  return withinSignOutDeadline(auth.signOut({ scope: "others" }));
}

/** `call`'s result, or the deadline as its error once {@link SIGN_OUT_TIMEOUT_MS} has passed. */
async function withinSignOutDeadline(
  call: Promise<{ error: unknown }>,
): Promise<{ error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ error: unknown }>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          error: new Error(`Auth did not answer the sign-out within ${SIGN_OUT_TIMEOUT_MS} ms`),
        }),
      SIGN_OUT_TIMEOUT_MS,
    );
  });
  const result = await Promise.race([
    call.catch((thrown: unknown) => ({ error: thrown })),
    deadline,
  ]);
  clearTimeout(timer);
  return result;
}

/**
 * Connects a Supabase auth client to {@link SessionAdapter}.
 *
 * The distinction this preserves is the one that decides whether anybody is signed out: only
 * auth ANSWERING proves a session is gone. A fetch that never landed says nothing about it, and
 * neither does a 5xx, which is auth failing rather than auth answering. A thrown network error
 * stays on that side of the line too.
 *
 * Pass `stored` and `signOut` goes through {@link signOutEvenOffline}. That changes what its
 * rejection means. It still rejects when auth did not end the session, but by then the session
 * has already left this device. And a sign-out auth has not answered within
 * {@link SIGN_OUT_TIMEOUT_MS} now rejects instead of hanging. Without `stored`, it is
 * `auth.signOut({ scope: "local" })` and rejects on that call's error. Either way it ends this
 * device's session only: a token one device's API refused says nothing about the others.
 *
 * `stored` is optional here but not at a sign-out button. The API client signs out only after
 * auth has answered: a refresh auth refused, or a new token the API refused. So the network was up
 * a moment earlier, and what `stored` covers is the connection dropping in between.
 */
export function createSupabaseSessionAdapter(
  auth: SupabaseSessionAuth,
  stored?: SupabaseSessionStorage,
): SessionAdapter {
  return {
    getToken: async () => {
      const { data } = await auth.getSession();
      return data.session?.access_token ?? null;
    },
    refresh: async () => {
      try {
        const { data, error } = await auth.refreshSession();
        return {
          token: data.session?.access_token ?? null,
          reachedAuth: error === null || reachedAuth(error),
        };
      } catch (error) {
        return { token: null, reachedAuth: reachedAuth(error) };
      }
    },
    signOut: async () => {
      const { error } = stored
        ? await signOutEvenOffline(auth, stored)
        : await auth.signOut({ scope: "local" });
      if (error) throw error;
    },
  };
}

/**
 * Every link type a GoTrue email can carry, including ones this app's templates do not send today.
 * One donor rejected `invite` because "invites are never sent", which was true of the product and
 * false of the deployment: an operator inviting somebody from Studio sent a branded email whose
 * link then said it was invalid. A type the templates never emit costs nothing to accept: the hash
 * is the proof, and GoTrue opens a session only for the person whose one-time token it is.
 *
 * Closed on purpose: auth-js's own `EmailOtpType` ends in `(string & {})`, so it cannot make a
 * destination map name every case. `Record<EmailLinkType, string>` can, and that is where an app
 * decides that `recovery` and `invite` both continue to the new-password screen. GoTrue creates an
 * invited account with NO password, so landing one "inside" signs them in once and locks them out
 * after.
 */
export type EmailLinkType =
  "signup" | "invite" | "magiclink" | "recovery" | "email_change" | "email";

const EMAIL_LINK_TYPES: Record<EmailLinkType, true> = {
  signup: true,
  invite: true,
  magiclink: true,
  recovery: true,
  email_change: true,
  email: true,
};

function isEmailLinkType(value: string): value is EmailLinkType {
  // Not `in`: `"toString" in EMAIL_LINK_TYPES` is true, and the type is typed by whoever sends
  // the link.
  return Object.hasOwn(EMAIL_LINK_TYPES, value);
}

/** Everything an auth callback address can carry, decided from the address alone. */
export type AuthCallback =
  /** An email link with a one-use `token_hash`: trade it with `verifyOtp`, exactly once. */
  | { kind: "email-link"; tokenHash: string; type: EmailLinkType }
  /**
   * A session arriving in the address: a PKCE `code`, or the implicit flow's tokens. In a browser
   * with `detectSessionInUrl` on, the client has already taken it. Wait for the session, and do not
   * trade it again, which would be a second exchange racing the first. Where nothing reads the
   * address for you (React Native), `credential` is what `exchangeCodeForSession` or `setSession`
   * takes.
   */
  | {
      kind: "session";
      type: EmailLinkType | null;
      credential: { code: string } | { access_token: string; refresh_token: string };
    }
  /**
   * GoTrue, or the provider behind it, reported a failure in the address. `code` is GoTrue's stable
   * `error_code` (`otp_expired`, `bad_oauth_state`, …) and is what to choose words by;
   * `error_description` is left out because it is English-only and often names the wrong cause.
   */
  | { kind: "error"; error: string | null; code: string | null; cancelled: boolean }
  /** Nothing usable: cut short between the mail client and here, or edited by hand. */
  | { kind: "invalid" };

/**
 * Reads an auth callback address. Pure, so every edge case is testable without a router or a
 * client. Pass `location.search` and `location.hash`, or the two halves of a deep link.
 *
 * GoTrue writes a failure into the FRAGMENT on every path and into the query only on some. After a
 * provider round trip, it writes both; after an implicit-flow email link, it writes the fragment
 * alone. A callback reading one of the two misses a failure the other carries, and the person lands
 * on a screen that says nothing. Both are read here.
 *
 * `cancelled` is the provider refusing on its own, which for Google is the person pressing Cancel.
 * That is their choice, not a failure to report. It is NOT `error === "access_denied"`: GoTrue
 * writes that same value for an expired email link, a banned user and a disabled signup, each with
 * an `error_code` beside it, while a refusal relayed from the provider arrives with none. The
 * obvious test reads an expired link as a change of mind. And `error` itself is absent for a status
 * outside GoTrue's OAuth mapping. A rate-limited link arrives with `error_code` alone.
 */
export function parseAuthCallback(search: string | URLSearchParams, hash = ""): AuthCallback {
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  const read = (name: string) => query.get(name) || fragment.get(name) || null;

  const error = read("error");
  const code = read("error_code");
  if (error || code || read("error_description"))
    return { kind: "error", error, code, cancelled: error === "access_denied" && code === null };

  const rawType = read("type") ?? "";
  const type = isEmailLinkType(rawType) ? rawType : null;

  const tokenHash = query.get("token_hash")?.trim();
  if (tokenHash) return type ? { kind: "email-link", tokenHash, type } : { kind: "invalid" };

  const pkceCode = query.get("code");
  if (pkceCode) return { kind: "session", type, credential: { code: pkceCode } };

  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  if (accessToken && refreshToken)
    return {
      kind: "session",
      type,
      credential: { access_token: accessToken, refresh_token: refreshToken },
    };

  return { kind: "invalid" };
}
