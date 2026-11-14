import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { returnPathFromLocation, safeInternalPath } from "./internal-path.ts";

/**
 * Route guards.
 *
 * Two donors wrote these four, gave two of them the same names, and explained them in nearly the
 * same words. What differed was one line. That line is invariant 4, so it is the reason this file
 * exists rather than being copied a ninth time.
 *
 * These are factories because the destinations are the app's: `paths.signIn` is not something a
 * package can know, and one donor hardcoded `/login` in four places for exactly that reason.
 *
 * A guard is a COURTESY, never the boundary. The API refuses what it refuses whatever any of
 * these decide. What they buy is that somebody who types a URL lands on one screen that
 * explains itself instead of four panels each failing separately.
 */

/** What the guard needs off the session store. */
export interface SessionState {
  isAuthenticated: boolean;
  isLoading: boolean;
}

/**
 * The answer to a "who is this?" query, in the three states it actually has.
 *
 * This shape is invariant 4. A guard reading `!me?.isStaff` collapses "pending", "failed" and "no"
 * into one branch, so an operator arriving while `/auth/me` is 500ing is told the page does not
 * exist. Wrong cause, no retry, and no request id to quote to support. One donor hit that and fixed
 * it; the other still has the collapsed version.
 *
 * `"pending"` and not `"loading"` for one measured reason: it is react-query's own word for this
 * state since v5, and with the words matching a `UseQueryResult<TMe>` satisfies this type
 * STRUCTURALLY: `createRequireProfile(useMe, …)` takes the hook directly, no adapter. With
 * `"loading"` it does not typecheck and every adopter hand-writes the same six-line mapping; eight
 * of the twelve repos this serves are on react-query, and the first migration wrote that mapping
 * before anyone noticed. Nothing here imports react-query at runtime. The type stays structural, so
 * an app on SWR or a plain `useState` still answers it in three lines.
 */
export type MeQuery<TMe> =
  | { status: "pending" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: TMe };

/**
 * The paragraph above, pinned so it cannot quietly stop being true. A renamed state or a newly
 * required field stops compiling HERE, which is cheaper than eight repos each finding out by
 * writing an adapter. `import type` erases, so the built barrel never mentions react-query —
 * `bun run exports` is what proves that, and it is why the peer stays optional.
 */
type Satisfied<T extends true> = T;
type _QueryResultIsAMeQuery = Satisfied<
  UseQueryResult<{ id: string }, Error> extends MeQuery<{ id: string }> ? true : false
>;

export interface GuardOptions {
  /** Drawn while the session or the profile is still resolving. */
  loading: ReactNode;
}

/** Query parameter carrying the route a sign-in interrupted. */
export const AUTH_RETURN_PARAM = "next";

function signInUrl(signInPath: string, returnTo: string): string {
  const separator = signInPath.includes("?") ? "&" : "?";
  return `${signInPath}${separator}${AUTH_RETURN_PARAM}=${encodeURIComponent(returnTo)}`;
}

/**
 * Require sign-in and remember where they were headed, so the redirect afterwards lands on the page
 * they actually wanted rather than the home screen.
 */
export function createRequireAuth(
  useSession: () => SessionState,
  signInPath: string,
  { loading }: GuardOptions,
) {
  return function RequireAuth({ children }: { children: ReactNode }) {
    const { isAuthenticated, isLoading } = useSession();
    const location = useLocation();
    if (isLoading) return <>{loading}</>;
    if (!isAuthenticated) {
      // Query state survives a reload, an OAuth round trip and an email-link round trip. Router
      // state survives none of them, so it only looked like a remembered destination on the
      // password path. The hash belongs too: tabs and anchored settings are real destinations —
      // but not when it is the round trip itself, which is why this is not a concatenation. This
      // guard renders exactly when there is no session yet, and that is the state an implicit-flow
      // callback is in while its client parses the fragment: point an OAuth `redirectTo` at a
      // guarded route and the raw hash is a refresh token, on its way into a query string.
      const returnTo = returnPathFromLocation(location);
      return <Navigate to={signInUrl(signInPath, returnTo)} replace />;
    }
    return <>{children}</>;
  };
}

/** The mirror: somebody already signed in has no business on the sign-in screen. */
export function createRequireAnonymous(
  useSession: () => SessionState,
  homePath: string,
  { loading }: GuardOptions,
) {
  return function RequireAnonymous({ children }: { children: ReactNode }) {
    const { isAuthenticated, isLoading } = useSession();
    const location = useLocation();
    if (isLoading) return <>{loading}</>;
    if (isAuthenticated) {
      const carried = new URLSearchParams(location.search).get(AUTH_RETURN_PARAM);
      return <Navigate to={safeInternalPath(carried) ?? homePath} replace />;
    }
    return <>{children}</>;
  };
}

/**
 * A gate on a profile field, such as whether the person is suspended, staff or on a given plan.
 *
 * `allow` gets the profile and answers yes or no. `onDenied` draws the refusal; `onError` draws
 * the failure, and they are SEPARATE arguments on purpose. That separation is the whole point
 * of this file: "you may not see this" and "we could not find out" are different sentences, and
 * showing the first when the second is true is how an outage becomes a support ticket about
 * permissions.
 */
export function createRequireProfile<TMe>(useMe: () => MeQuery<TMe>, { loading }: GuardOptions) {
  return function requireProfile(
    allow: (me: TMe) => boolean,
    onDenied: ReactNode | (() => ReactNode),
    onError: (error: unknown) => ReactNode,
  ) {
    return function RequireProfile({ children }: { children: ReactNode }) {
      const query = useMe();
      if (query.status === "pending") return <>{loading}</>;
      if (query.status === "error") return <>{onError(query.error)}</>;
      if (!allow(query.data)) return <>{typeof onDenied === "function" ? onDenied() : onDenied}</>;
      return <>{children}</>;
    };
  };
}
