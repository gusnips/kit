import { hashKey, useMutation, useQuery, type QueryKey } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import type { ApiClient, RequestOptions } from "./api-client.ts";

/**
 * The two pages behind an agent's sign-in: the consent page, where Claude or ChatGPT sends a
 * person to connect, and the device page, where a script's short code is typed and approved.
 * `@gusnips/server/oauth` is the server half. Logic only: the pages are the product's.
 *
 * Each hook takes your two API calls, so your client, your session and your envelope stay yours,
 * and returns one state to draw. `createOAuthConsoleApi` writes those calls for the server's
 * `oauthConsoleRoutes`. What they settle once:
 *
 * - A refusal (an unknown app, a return address it never registered) is a STATE, never a
 *   redirect: sending the browser anywhere on a bad request is how an open redirect is built.
 * - Approve stays busy from the press until the browser has left. The page is going away, so the
 *   button must never come back and invite a second press.
 * - A device code is read however it is typed (`wdjb mjht`, `WDJB-MJHT`), and once decided the
 *   page stays decided. Asked again, the server no longer knows the code, and a page that asked on
 *   the next focus would tell someone who just approved that their code is wrong.
 */

export type OAuthRefusalReason =
  "unknown-client" | "redirect-mismatch" | "invalid-request" | "wrong-resource" | "unknown-code";

/** What the server sends instead of a view. Word your own page for `reason`. */
export interface OAuthRefusal {
  ok: false;
  reason: OAuthRefusalReason;
  /** An English fallback a person can read. */
  message: string;
}

/** `Extra` is anything your server adds to the view, such as the workspaces a person may pick. */
export type ConsentView<Extra extends object = object> = Extra & {
  ok: true;
  /** What the app calls itself. Anyone may pick any name, so show `redirectHost` beside it. */
  clientName: string;
  /** Where the browser goes after the yes: a host, or an app's own scheme (`cursor:`). */
  redirectHost: string;
  /** The key's name on your keys page. */
  keyName: string;
  /** Where "Cancel" goes: back to the app, which is told the person said no. */
  cancelUrl: string;
};

export type DeviceView<Extra extends object = object> = Extra & {
  ok: true;
  clientName: string;
  /** As the script printed it: `WDJB-MJHT`. */
  userCode: string;
  keyName: string;
  /** ISO time: JSON carries the server's `Date` as a string. */
  expiresAt: string;
};

/** Capture this from your app's identity store on each account or workspace generation. */
export interface OAuthScope {
  /** Query-key prefix, including account, workspace and the identity generation. Never a token. */
  readonly key: QueryKey;
  /** Compare the captured generation with the live store, even before React renders again. */
  isCurrent(): boolean;
}

/** A decision outlived its account, request or page. Aborting does not undo a server-side decision. */
export class OAuthOperationChangedError extends Error {
  constructor() {
    super(
      "The account, sign-in request or page changed before the decision finished. Check connected apps in the account you used before trying again.",
    );
    this.name = "OAuthOperationChangedError";
  }
}

interface OAuthOperation {
  identity: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  release(): void;
}

function assertCurrent(operation: OAuthOperation): void {
  if (!operation.isCurrent()) throw new OAuthOperationChangedError();
}

function createOperationLifetime(identity: string) {
  let mounted = false;
  let generation = 0;
  const controllers = new Set<AbortController>();
  return {
    identity,
    invalidate() {
      generation++;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
    mount() {
      mounted = true;
      return () => {
        mounted = false;
        this.invalidate();
      };
    },
    capture(isCurrent: () => boolean): OAuthOperation {
      const started = generation;
      const controller = new AbortController();
      controllers.add(controller);
      return {
        identity,
        signal: controller.signal,
        isCurrent: () => mounted && started === generation && isCurrent(),
        release: () => controllers.delete(controller),
      };
    },
  };
}

/** Both pages reject late answers, even when the adapter ignores abort or the cache was cleared. */
function useOAuthOperation(scope: OAuthScope, kind: "consent" | "device", input: string) {
  const key = [...scope.key, "@gusnips/react/oauth", kind, input];
  const identity = hashKey(key);
  const lifetime = useMemo(() => createOperationLifetime(identity), [identity]);
  // Invalidate by the commit, before passive cleanup can leave a late redirect window.
  // Layout effects work on native too and do not run during SSR. StrictMode can mount again.
  useLayoutEffect(() => lifetime.mount(), [lifetime]);
  return { key, lifetime, capture: () => lifetime.capture(() => scope.isCurrent()) };
}

export interface ConsentApi<Choice = void, Extra extends object = object> {
  /** Forward `options`, including its signal, to your HTTP client. */
  describe(query: string, options?: RequestOptions): Promise<ConsentView<Extra> | OAuthRefusal>;
  /** Your API's call to `approve`. `choice` is anything your page adds, such as a workspace. */
  approve(
    query: string,
    choice: Choice,
    options?: RequestOptions,
  ): Promise<{ ok: true; redirectTo: string } | OAuthRefusal>;
}

export type ConsentState<Extra extends object = object> =
  | { status: "loading" }
  /** Show `refusal` and a way home. Never a link back to the app. */
  | { status: "refused"; refusal: OAuthRefusal }
  /** The request failed to arrive or answer. Show what failed, and `retry`. */
  | { status: "failed"; error: unknown; retry: () => void }
  | { status: "ready"; view: ConsentView<Extra> };

export interface ConsentRequest<Choice = void, Extra extends object = object> {
  state: ConsentState<Extra>;
  approve(choice: Choice): void;
  /** From the press until the browser has left. Keep the button busy the whole time. */
  leaving: boolean;
  /** Approve did not answer. Show it beside the button; pressing again retries. */
  approveError: unknown;
}

/**
 *     const consent = useConsentRequest(api.oauth, useLocation().search, scope);
 *     if (consent.state.status === "ready") ... consent.approve(workspaceId)
 */
export function useConsentRequest<Choice = void, Extra extends object = object>(
  api: ConsentApi<Choice, Extra>,
  search: string,
  scope: OAuthScope,
): ConsentRequest<Choice, Extra> {
  const query = search.replace(/^\?/, "");
  const { key, lifetime, capture } = useOAuthOperation(scope, "consent", query);
  const request = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.describe(query, { signal }),
    // A previous description is never a safe stand-in for this approval target.
    placeholderData: () => undefined,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const approval = useMutation({
    mutationFn: async (pressed: {
      api: ConsentApi<Choice, Extra>;
      query: string;
      choice: Choice;
      operation: OAuthOperation;
    }) => {
      const { api, query, choice, operation } = pressed;
      try {
        assertCurrent(operation);
        const answer = await api.approve(query, choice, { signal: operation.signal });
        // Before returning: stale success data must never enter the mutation cache.
        assertCurrent(operation);
        return answer;
      } finally {
        operation.release();
      }
    },
    onSettled: (answer, error, { operation }) => {
      // Global success and settlement callbacks may await an identity change. Check last.
      if (error !== null) return;
      assertCurrent(operation);
      if (answer?.ok) window.location.assign(answer.redirectTo);
    },
    retry: false,
    networkMode: "always",
  });
  const currentApproval =
    approval.variables?.operation.identity === lifetime.identity &&
    approval.variables.operation.isCurrent();

  // A refusal from approve (the request went stale between the two calls) outranks the view.
  const answer = request.data;
  let refusal = answer?.ok === false ? answer : null;
  if (currentApproval && approval.data?.ok === false) refusal = approval.data;
  let state: ConsentState<Extra>;
  if (refusal) state = { status: "refused", refusal };
  else if (answer?.ok === true) state = { status: "ready", view: answer };
  else if (request.isError)
    state = { status: "failed", error: request.error, retry: () => void request.refetch() };
  else state = { status: "loading" };

  return {
    state,
    approve: (choice) => approval.mutate({ api, query, choice, operation: capture() }),
    leaving: currentApproval && (approval.isPending || approval.data?.ok === true),
    approveError: currentApproval ? approval.error : null,
  };
}

export interface DeviceApi<Choice = void, Extra extends object = object> {
  /** Forward `options`, including its signal, to your HTTP client. */
  describe(code: string, options?: RequestOptions): Promise<DeviceView<Extra> | OAuthRefusal>;
  /** Your API's call to `decideDevice`. `choice` comes with a yes only, as on the consent page. */
  decide(
    code: string,
    decision: "approve" | "deny",
    choice?: Choice,
    options?: RequestOptions,
  ): Promise<{ ok: true } | OAuthRefusal>;
}

export type DeviceState<Extra extends object = object> =
  /** Fewer than 8 letters so far, or one a code never uses (see `invalidLetter`). */
  | { status: "typing" }
  | { status: "loading" }
  /** Unknown, expired or already decided: ask them to start again from the app. */
  | { status: "refused"; refusal: OAuthRefusal }
  | { status: "failed"; error: unknown; retry: () => void }
  /**
   * Show `view.userCode` and say: go on only if you started this sign-in yourself, just now, and
   * this is the code on your screen. Somebody can run the real script and send a stranger the
   * link, and that sentence is the only guard against it (RFC 8628 §5.4).
   */
  | { status: "ready"; view: DeviceView<Extra> }
  /** Done. Tell them to go back to the app, which carries on by itself. */
  | { status: "approved" }
  | { status: "denied" };

export interface DeviceApproval<Choice = void, Extra extends object = object> {
  state: DeviceState<Extra>;
  /** What the field shows, formatted as they type: `WDJB-MJ`. */
  code: string;
  setCode(input: string): void;
  /** A typed letter no code uses: a vowel. Say so now, not after eight letters. */
  invalidLetter: boolean;
  approve(choice: Choice): void;
  deny(): void;
  deciding: boolean;
  /** Which button was pressed, until the server answers: put the spinner on that one. */
  pending: "approve" | "deny" | null;
  /** The decision did not answer. Show it beside the buttons; pressing again retries. */
  decideError: unknown;
}

/** The server's alphabet: no vowels, so a code never spells a word. */
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const LENGTH = 8;

// Private wiring between the approval and field hooks, without adding to the public page API.
const deviceAddressWrites = new WeakMap<object, (code: string) => void>();

/** Upper case, letters only, at most 8, with the dash after the fourth: what the field shows. */
export function formatUserCode(input: string): string {
  const letters = input
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, LENGTH);
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

/**
 *     const device = useDeviceApproval(api.device, useLocation().search, scope);
 *     <input value={device.code} onChange={(e) => device.setCode(e.target.value)} />
 *
 * The link the script prints carries `?code=`, so the field usually starts full.
 */
export function useDeviceApproval<Choice = void, Extra extends object = object>(
  api: DeviceApi<Choice, Extra>,
  search: string,
  scope: OAuthScope,
): DeviceApproval<Choice, Extra> {
  const fromLink = formatUserCode(new URLSearchParams(search).get("code") ?? "");
  const [input, setInput] = useState<{
    fromLink: string;
    code: string;
    ownAddress?: string;
  }>({ fromLink, code: fromLink });
  const recordAddressWrite = useCallback((ownAddress: string) => {
    setInput((current) => ({ ...current, ownAddress }));
  }, []);
  // Only external links replace input. The field also writes the address while typing and
  // clears it after a decision; neither write should replace input or invalidate the decision.
  const code = input.fromLink === fromLink || input.ownAddress === fromLink ? input.code : fromLink;
  if (input.fromLink !== fromLink) setInput({ fromLink, code });
  const letters = code.replace("-", "");
  const invalidLetter = [...letters].some((letter) => !ALPHABET.includes(letter));
  const complete = letters.length === LENGTH && !invalidLetter;
  const { key, lifetime, capture } = useOAuthOperation(scope, "device", letters);

  const decision = useMutation({
    mutationFn: async (pressed: {
      api: DeviceApi<Choice, Extra>;
      code: string;
      decision: "approve" | "deny";
      choice?: Choice;
      operation: OAuthOperation;
    }) => {
      const { api, code, decision, choice, operation } = pressed;
      try {
        assertCurrent(operation);
        const answer = await api.decide(code, decision, choice, { signal: operation.signal });
        assertCurrent(operation);
        return answer;
      } finally {
        operation.release();
      }
    },
    onSettled: (_answer, error, { operation }) => {
      if (error === null) assertCurrent(operation);
    },
    retry: false,
    networkMode: "always",
  });
  const currentDecision =
    decision.variables?.operation.identity === lifetime.identity &&
    decision.variables.operation.isCurrent();
  const decided =
    currentDecision && decision.isSuccess && decision.data.ok
      ? decision.variables.decision
      : undefined;
  const request = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.describe(letters, { signal }),
    enabled: complete && decided === undefined,
    placeholderData: () => undefined,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const answer = request.data;
  let refusal = answer?.ok === false ? answer : null;
  if (currentDecision && decision.data?.ok === false) refusal = decision.data;
  let state: DeviceState<Extra>;
  if (decided !== undefined) state = { status: decided === "approve" ? "approved" : "denied" };
  else if (!complete) state = { status: "typing" };
  else if (refusal) state = { status: "refused", refusal };
  else if (answer?.ok === true) state = { status: "ready", view: answer };
  else if (request.isError)
    state = { status: "failed", error: request.error, retry: () => void request.refetch() };
  else state = { status: "loading" };

  const device: DeviceApproval<Choice, Extra> = {
    state,
    code,
    setCode: (value) => {
      const next = formatUserCode(value);
      if (next === code) return;
      lifetime.invalidate();
      decision.reset();
      setInput((current) => ({ ...current, code: next }));
    },
    invalidLetter,
    approve: (choice) =>
      decision.mutate({ api, code: letters, decision: "approve", choice, operation: capture() }),
    deny: () => decision.mutate({ api, code: letters, decision: "deny", operation: capture() }),
    deciding: currentDecision && decision.isPending,
    pending: currentDecision && decision.isPending ? decision.variables.decision : null,
    decideError: currentDecision ? decision.error : null,
  };
  deviceAddressWrites.set(device, recordAddressWrite);
  return device;
}

export interface DeviceCodeField {
  /** Spread on the code's `<input>`. Point your `<label htmlFor>` at its `id`. */
  inputProps: {
    id: string;
    value: string;
    onChange(event: ChangeEvent<HTMLInputElement>): void;
    placeholder: string;
    autoComplete: "off";
    autoCapitalize: "characters";
    spellCheck: false;
    /** Only when the field starts empty: a code from the link is there to be read first. */
    autoFocus: boolean;
    disabled: boolean;
    "aria-invalid": boolean;
    "aria-describedby": string;
  };
  /** Spread on the line under the field that says what is happening: a vowel, checking, refused. */
  statusProps: { id: string; "aria-live": "polite" };
}

/**
 *     const field = useDeviceCodeField(device);
 *     <label htmlFor={field.inputProps.id}>Code</label>
 *     <input {...field.inputProps} />
 *     <p {...field.statusProps}>{device.invalidLetter ? "Codes have no vowels." : null}</p>
 *
 * The field's wiring, and the code kept in the address as `?code=`, so a reload or a shared link
 * comes back to the same code. The address is replaced, never pushed, so Back still leaves the
 * page, and the router's own state rides along. Once decided the code leaves the address: the
 * server no longer knows it, and a reload would only tell the person it is wrong.
 */
export function useDeviceCodeField<Choice, Extra extends object>(
  device: DeviceApproval<Choice, Extra>,
): DeviceCodeField {
  const id = useId();
  const statusId = `${id}-status`;
  const { status } = device.state;
  const inAddress = status === "approved" || status === "denied" ? "" : device.code;
  const recordAddressWrite = deviceAddressWrites.get(device);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (inAddress) url.searchParams.set("code", inAddress);
    else url.searchParams.delete("code");
    if (url.href !== window.location.href) {
      recordAddressWrite?.(inAddress);
      window.history.replaceState(window.history.state, "", url);
    }
  }, [inAddress, recordAddressWrite]);

  return {
    inputProps: {
      id,
      value: device.code,
      onChange: (event) => device.setCode(event.target.value),
      placeholder: "WDJB-MJHT",
      autoComplete: "off",
      autoCapitalize: "characters",
      spellCheck: false,
      autoFocus: device.code === "",
      disabled: device.deciding,
      "aria-invalid": device.invalidLetter || status === "refused",
      "aria-describedby": statusId,
    },
    statusProps: { id: statusId, "aria-live": "polite" },
  };
}

/** The calls the console API makes. `createApiClient`'s client fits as it is. */
export type OAuthConsoleHttp = Pick<ApiClient, "get" | "post">;

/**
 *     export const oauthApi = createOAuthConsoleApi(api, "/auth/oauth");
 *     useConsentRequest(oauthApi.consent, search, scope);
 *     useDeviceApproval(oauthApi.device, search, scope);
 *
 * Both pages' calls to the server's `oauthConsoleRoutes`, mounted at `basePath` behind your
 * sign-in. A choice travels as `choice`, which is where those routes hand it to your approver.
 * `ConsentExtra` and `DeviceExtra` are the fields your server adds to each page's view.
 */
export function createOAuthConsoleApi<
  Choice = void,
  ConsentExtra extends object = object,
  DeviceExtra extends object = object,
>(
  http: OAuthConsoleHttp,
  basePath: string,
): { consent: ConsentApi<Choice, ConsentExtra>; device: DeviceApi<Choice, DeviceExtra> } {
  return {
    consent: {
      describe: (query, options) => http.get(`${basePath}/request?${query}`, options),
      approve: (query, choice, options) =>
        http.post(`${basePath}/approve`, { query, choice }, options),
    },
    device: {
      describe: (code, options) =>
        http.get(`${basePath}/device?code=${encodeURIComponent(code)}`, options),
      decide: (code, decision, choice, options) =>
        http.post(`${basePath}/device`, { code, decision, choice }, options),
    },
  };
}
