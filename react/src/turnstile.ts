import { useMemo, useSyncExternalStore, type RefCallback } from "react";

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const SCRIPT_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;
const LOAD_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 60_000;
const TOKEN_LIFETIME_MS = 300_000;

export type TurnstileState =
  | "off"
  | "idle"
  | "loading"
  | "ready"
  | "interactive"
  | "failed"
  | "unavailable"
  | "unsupported";

export class TurnstileError extends Error {
  constructor(readonly reason: "failed" | "unavailable" | "unsupported" | "busy" | "cancelled") {
    super(
      {
        failed: "The security check did not finish. Try again.",
        unavailable:
          "The security check could not load. Check your connection or blocker, then retry.",
        unsupported:
          "This browser cannot run the security check. Update it or use another browser.",
        busy: "A security check is already pending. Wait for that request to finish.",
        cancelled: "The form changed or closed. Start the request again on the current form.",
      }[reason],
    );
    this.name = "TurnstileError";
  }
}

export interface TurnstileOptions {
  /** Public widget key. Unset means off, not that server protection is active. */
  siteKey: string | undefined;
  /** A server-owned name for this form, such as "signin" or "contact". */
  action: string;
  language?: string;
  theme?: "auto" | "light" | "dark";
  /** Start on mount by default. False waits for take() or retry(), without loading a script. */
  eager?: boolean;
}

export interface TurnstileControl {
  container: RefCallback<HTMLDivElement>;
  state: TurnstileState;
  take: () => Promise<string | undefined>;
  retry: () => void;
}

interface WidgetOptions {
  sitekey: string;
  action: string;
  language: string;
  theme: "auto" | "light" | "dark";
  appearance: "interaction-only";
  size: "compact" | "flexible";
  "response-field": false;
  "refresh-expired": "never";
  retry: "never";
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => boolean;
  "timeout-callback": () => void;
  "unsupported-callback": () => void;
  "before-interactive-callback": () => void;
  "after-interactive-callback": () => void;
}

interface TurnstileApi {
  render(element: HTMLElement, options: WidgetOptions): string | null | undefined;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Share the script, never widget state. A failed attempt removes only the tag it created. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  const attempt = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    const detach = () => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
    };
    const fail = () => {
      detach();
      reject(new TurnstileError("unavailable"));
      try {
        script.remove();
      } catch {
        // A cleanup failure must not strand the load or prevent its next attempt.
      }
    };
    const timer = setTimeout(fail, LOAD_TIMEOUT_MS);
    try {
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () => {
        if (!window.turnstile) return fail();
        detach();
        resolve(window.turnstile);
      };
      script.onerror = fail;
      document.head.append(script);
    } catch {
      fail();
    }
  });
  loading = attempt;
  // A synchronous insertion failure must be forgotten too, after this assignment has happened.
  void attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return attempt;
}

interface PendingToken {
  resolve: (token: string) => void;
  reject: (error: TurnstileError) => void;
}

/** A callback ref owns a widget's lifetime, including StrictMode's cleanup and remount. */
function createWidget({
  siteKey,
  action,
  language = "auto",
  theme = "auto",
  eager = true,
}: TurnstileOptions) {
  let element: HTMLDivElement | null = null;
  let state: TurnstileState = siteKey ? "idle" : "off";
  let token: { value: string; expiresAt: number } | null = null;
  let pending: PendingToken | null = null;
  let stopRound = () => {};
  const listeners = new Set<() => void>();
  const setState = (next: TurnstileState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const fail = (reason: "failed" | "unavailable" | "unsupported" | "cancelled") => {
    token = null;
    const waiting = pending;
    pending = null;
    waiting?.reject(new TurnstileError(reason));
    stopRound();
    if (reason !== "cancelled") setState(reason);
  };

  function start() {
    if (!siteKey || !element) return;
    stopRound();
    token = null;
    setState("loading");
    let live = true;
    let widget: { api: TurnstileApi; id: string } | null = null;
    stopRound = () => {
      if (!live) return;
      live = false;
      if (widget) {
        try {
          widget.api.remove(widget.id);
        } catch {
          // The SDK must not break React cleanup or the token promise's settlement.
        }
      }
    };
    void loadTurnstile().then(
      (api) => {
        if (!live || !element) return;
        const refuse = () => {
          if (live) fail("failed");
        };
        try {
          const id = api.render(element, {
            sitekey: siteKey,
            action,
            language: language.toLowerCase(),
            theme,
            appearance: "interaction-only",
            size: element.clientWidth < 300 ? "compact" : "flexible",
            "response-field": false,
            "refresh-expired": "never",
            retry: "never",
            callback: (value) => {
              if (!live) return;
              if (!value) return refuse();
              const waiting = pending;
              if (waiting) {
                // The token goes to one waiter, never into state where a second take can see it.
                pending = null;
                waiting.resolve(value);
                start();
              } else {
                token = { value, expiresAt: Date.now() + TOKEN_LIFETIME_MS };
                setState("ready");
              }
            },
            "expired-callback": () => {
              if (live) start();
            },
            "error-callback": () => {
              refuse();
              return true;
            },
            "timeout-callback": refuse,
            "unsupported-callback": () => {
              if (live) fail("unsupported");
            },
            "before-interactive-callback": () => {
              if (live) setState("interactive");
            },
            "after-interactive-callback": () => {
              if (live && !token) setState("loading");
            },
          });
          if (!id) return refuse();
          // A callback can consume a token synchronously inside render, ending this round.
          if (live) widget = { api, id };
          else api.remove(id);
        } catch {
          refuse();
        }
      },
      () => {
        if (live) fail("unavailable");
      },
    );
  }

  const container: RefCallback<HTMLDivElement> = (node) => {
    element = node;
    if (eager) start();
    return () => {
      element = null;
      fail("cancelled");
      setState(siteKey ? "idle" : "off");
    };
  };

  function take(): Promise<string | undefined> {
    if (!siteKey) return Promise.resolve(undefined);
    if (!element) return Promise.reject(new TurnstileError("cancelled"));
    if (state === "unsupported") return Promise.reject(new TurnstileError("unsupported"));
    if (pending) return Promise.reject(new TurnstileError("busy"));
    const available = token;
    // Consume before yielding, not after a React state update or an awaited promise.
    token = null;
    if (available && available.expiresAt > Date.now()) {
      start();
      return Promise.resolve(available.value);
    }
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => fail("failed"), TOKEN_TIMEOUT_MS);
      pending = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
    if (available || state === "idle" || state === "failed" || state === "unavailable") start();
    return promise;
  }

  return {
    container,
    take,
    retry: () => {
      if (state !== "unsupported") start();
    },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * One browser check for one form. Render `<div ref={check.container} />` near its submit button.
 * `await check.take()` returns a token once, or undefined when the site key is unset. Only one
 * acquisition may wait at a time; a concurrent take rejects as busy, never sharing its token.
 * Changing options or unmounting cancels waiting calls and discards old tokens.
 *
 * Show loading/interactive states and explain failed/unavailable states with a retry button.
 * For unsupported browsers, ask the person to update or change browsers instead of retrying.
 * Keep the form's input on every failure. Tokens expire after five minutes. Send each token to
 * your API verifier OR to GoTrue's captchaToken, never both: verification consumes it.
 */
export function useTurnstile({
  siteKey,
  action,
  language,
  theme,
  eager,
}: TurnstileOptions): TurnstileControl {
  const widget = useMemo(
    () => createWidget({ siteKey, action, language, theme, eager }),
    [siteKey, action, language, theme, eager],
  );
  const state = useSyncExternalStore(widget.subscribe, widget.getSnapshot, widget.getSnapshot);
  return { container: widget.container, state, take: widget.take, retry: widget.retry };
}
