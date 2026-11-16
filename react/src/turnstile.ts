import { useMemo, useSyncExternalStore, type RefCallback } from "react";
import {
  createTurnstileMachine,
  TURNSTILE_ORIGIN,
  TurnstileError,
  type TurnstileState,
} from "./turnstile-machine.ts";

export { TURNSTILE_ORIGIN, TurnstileError, type TurnstileState };

const SCRIPT_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;
const LOAD_TIMEOUT_MS = 30_000;

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

/** A callback ref owns a widget's lifetime, including StrictMode's cleanup and remount. */
function createWidget({
  siteKey,
  action,
  language = "auto",
  theme = "auto",
  eager = true,
}: TurnstileOptions) {
  let element: HTMLDivElement | null = null;
  const machine = createTurnstileMachine({
    enabled: Boolean(siteKey),
    eager,
    driver: (round) => {
      let stopped = false;
      let widget: { api: TurnstileApi; id: string } | null = null;
      void loadTurnstile().then(
        (api) => {
          if (stopped || !element || !siteKey) return;
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
              callback: round.token,
              "expired-callback": round.expired,
              "error-callback": () => {
                round.failed();
                return true;
              },
              "timeout-callback": round.failed,
              "unsupported-callback": round.unsupported,
              "before-interactive-callback": round.interactive,
              "after-interactive-callback": round.afterInteractive,
            });
            if (!id) return round.failed();
            // A callback can consume a token synchronously inside render, ending this round.
            if (stopped) api.remove(id);
            else widget = { api, id };
          } catch {
            round.failed();
          }
        },
        () => round.unavailable(),
      );
      return () => {
        stopped = true;
        if (widget) {
          try {
            widget.api.remove(widget.id);
          } catch {
            // The SDK must not break React cleanup or the token promise's settlement.
          }
        }
      };
    },
  });

  const container: RefCallback<HTMLDivElement> = (node) => {
    element = node;
    if (node) machine.attach();
    return () => {
      element = null;
      machine.detach();
    };
  };

  return {
    container,
    take: machine.take,
    retry: machine.retry,
    getSnapshot: machine.getSnapshot,
    subscribe: machine.subscribe,
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
