import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState, type ChangeEvent } from "react";
import type { ApiClient } from "./api-client.ts";

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

export interface ConsentApi<Choice = void, Extra extends object = object> {
  /** Your API's call to the server's `describe`, with the query string as it came. */
  describe(query: string): Promise<ConsentView<Extra> | OAuthRefusal>;
  /** Your API's call to `approve`. `choice` is anything your page adds, such as a workspace. */
  approve(query: string, choice: Choice): Promise<{ ok: true; redirectTo: string } | OAuthRefusal>;
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
 *     const consent = useConsentRequest(api.oauth, useLocation().search);
 *     if (consent.state.status === "ready") ... consent.approve(workspaceId)
 */
export function useConsentRequest<Choice = void, Extra extends object = object>(
  api: ConsentApi<Choice, Extra>,
  search: string,
): ConsentRequest<Choice, Extra> {
  const query = search.replace(/^\?/, "");
  const request = useQuery({
    queryKey: ["@gusnips/react/oauth", "consent", query],
    queryFn: () => api.describe(query),
  });
  const approval = useMutation({
    mutationFn: (choice: Choice) => api.approve(query, choice),
    onSuccess: (answer) => {
      if (answer.ok) window.location.assign(answer.redirectTo);
    },
  });

  // A refusal from approve (the request went stale between the two calls) outranks the view.
  const answer = request.data;
  const refusal =
    approval.data?.ok === false ? approval.data : answer?.ok === false ? answer : null;
  let state: ConsentState<Extra>;
  if (refusal) state = { status: "refused", refusal };
  else if (answer?.ok === true) state = { status: "ready", view: answer };
  else if (request.isError)
    state = { status: "failed", error: request.error, retry: () => void request.refetch() };
  else state = { status: "loading" };

  return {
    state,
    approve: (choice) => approval.mutate(choice),
    leaving: approval.isPending || approval.data?.ok === true,
    approveError: approval.error,
  };
}

export interface DeviceApi<Choice = void, Extra extends object = object> {
  /** Your API's call to the server's `describeDevice`. */
  describe(code: string): Promise<DeviceView<Extra> | OAuthRefusal>;
  /** Your API's call to `decideDevice`. `choice` comes with a yes only, as on the consent page. */
  decide(
    code: string,
    decision: "approve" | "deny",
    choice?: Choice,
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

/** Upper case, letters only, at most 8, with the dash after the fourth: what the field shows. */
export function formatUserCode(input: string): string {
  const letters = input
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, LENGTH);
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

/**
 *     const device = useDeviceApproval(api.device, useLocation().search);
 *     <input value={device.code} onChange={(e) => device.setCode(e.target.value)} />
 *
 * The link the script prints carries `?code=`, so the field usually starts full.
 */
export function useDeviceApproval<Choice = void, Extra extends object = object>(
  api: DeviceApi<Choice, Extra>,
  search: string,
): DeviceApproval<Choice, Extra> {
  const [code, setTyped] = useState(() =>
    formatUserCode(new URLSearchParams(search).get("code") ?? ""),
  );
  const letters = code.replace("-", "");
  const invalidLetter = [...letters].some((letter) => !ALPHABET.includes(letter));
  const complete = letters.length === LENGTH && !invalidLetter;

  const decision = useMutation({
    mutationFn: (pressed: { decision: "approve" | "deny"; choice?: Choice }) =>
      api.decide(letters, pressed.decision, pressed.choice),
  });
  const decided = decision.isSuccess && decision.data.ok ? decision.variables.decision : undefined;
  const request = useQuery({
    queryKey: ["@gusnips/react/oauth", "device", letters],
    queryFn: () => api.describe(letters),
    enabled: complete && decided === undefined,
  });

  const answer = request.data;
  const refusal =
    decision.data?.ok === false ? decision.data : answer?.ok === false ? answer : null;
  let state: DeviceState<Extra>;
  if (decided !== undefined) state = { status: decided === "approve" ? "approved" : "denied" };
  else if (!complete) state = { status: "typing" };
  else if (refusal) state = { status: "refused", refusal };
  else if (answer?.ok === true) state = { status: "ready", view: answer };
  else if (request.isError)
    state = { status: "failed", error: request.error, retry: () => void request.refetch() };
  else state = { status: "loading" };

  return {
    state,
    code,
    setCode: (input) => {
      decision.reset();
      setTyped(formatUserCode(input));
    },
    invalidLetter,
    approve: (choice) => decision.mutate({ decision: "approve", choice }),
    deny: () => decision.mutate({ decision: "deny" }),
    deciding: decision.isPending,
    pending: decision.isPending ? decision.variables.decision : null,
    decideError: decision.error,
  };
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
  useEffect(() => {
    const url = new URL(window.location.href);
    if (inAddress) url.searchParams.set("code", inAddress);
    else url.searchParams.delete("code");
    if (url.href !== window.location.href)
      window.history.replaceState(window.history.state, "", url);
  }, [inAddress]);

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
 *     useConsentRequest(oauthApi.consent, search);
 *     useDeviceApproval(oauthApi.device, search);
 *
 * Both pages' calls to the server's `oauthConsoleRoutes`, mounted at `basePath` behind your
 * sign-in. A choice travels as `choice`, which is where those routes hand it to your approver.
 */
export function createOAuthConsoleApi<Choice = void>(
  http: OAuthConsoleHttp,
  basePath: string,
): { consent: ConsentApi<Choice>; device: DeviceApi<Choice> } {
  return {
    consent: {
      describe: (query) => http.get(`${basePath}/request?${query}`),
      approve: (query, choice) => http.post(`${basePath}/approve`, { query, choice }),
    },
    device: {
      describe: (code) => http.get(`${basePath}/device?code=${encodeURIComponent(code)}`),
      decide: (code, decision, choice) =>
        http.post(`${basePath}/device`, { code, decision, choice }),
    },
  };
}
