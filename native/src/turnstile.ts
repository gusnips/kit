/**
 * A Turnstile check for a bare React Native app's human forms: sign-in, sign-up, resend and reset.
 *
 * The check has the shape of `useTurnstile` from `@gusnips/react/turnstile`, because it is the same
 * check. The token rules come from the same state machine. What differs is the widget's home: a
 * phone has no page to put Cloudflare's script on, so the check runs in a small WebView that loads
 * its page as your product's https address, which is the hostname Cloudflare checks the token for.
 *
 * All the logic lives in `turnstile-bridge.ts`, which imports no native module and has the tests.
 * This file only puts the bridge's props on a real `WebView`.
 */
import { TurnstileError, type TurnstileState } from "@gusnips/react/turnstile-machine";
import { createElement, useEffect, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { createTurnstileBridge, type NativeTurnstileOptions } from "./turnstile-bridge.ts";

export { TurnstileError, type NativeTurnstileOptions, type TurnstileState };

export interface NativeTurnstileControl {
  /** Render it once, near the submit button. Null while no check is running. */
  view: ReactElement | null;
  state: TurnstileState;
  take: () => Promise<string | undefined>;
  retry: () => void;
}

// Out of sight but still laid out. A WebView with no size may never run its page.
const HIDDEN = { position: "absolute", width: 1, height: 1, opacity: 0 } as const;
// The height of Cloudflare's widget. It takes the width it is given.
const SHOWN = { alignSelf: "stretch", height: 65 } as const;
const PAGE = { flex: 1, backgroundColor: "transparent" } as const;

/**
 * One check for one form. Render `{check.view}` near the submit button, then `await check.take()`
 * for a token once, or `undefined` when `siteKey` is unset. Only one take may wait at a time, and a
 * second rejects as `busy`. Changing an option or leaving the screen cancels a waiting take.
 *
 * Nothing loads until the first `take()` or `retry()`, unless you pass `eager: true`.
 *
 * `check.view` shows only when Cloudflare needs the person, so keep room for a 65 point high box
 * under the button. Show `loading` and `interactive` beside it, explain `failed` and `unavailable`
 * with a retry button, and for `unsupported` ask the person to update their phone's browser engine
 * (the system WebView) instead of retrying. Keep the form's input on every failure. A token lasts
 * five minutes and is spent by the first server that checks it: send it to your API verifier OR to
 * Supabase's `captchaToken`, never both.
 */
export function useTurnstile({
  siteKey,
  action,
  origin,
  language,
  theme,
  eager,
}: NativeTurnstileOptions): NativeTurnstileControl {
  const bridge = useMemo(
    () => createTurnstileBridge({ siteKey, action, origin, language, theme, eager }),
    [siteKey, action, origin, language, theme, eager],
  );
  const { state, view } = useSyncExternalStore(
    bridge.subscribe,
    bridge.getSnapshot,
    bridge.getSnapshot,
  );
  useEffect(() => {
    bridge.attach();
    return bridge.detach;
  }, [bridge]);
  return {
    view:
      view &&
      createElement(
        View,
        {
          key: view.key,
          style: view.shown ? SHOWN : HIDDEN,
          pointerEvents: view.shown ? "auto" : "none",
          accessibilityElementsHidden: !view.shown,
          importantForAccessibility: view.shown ? "auto" : "no-hide-descendants",
        },
        createElement(WebView, { ...view.props, style: PAGE }),
      ),
    state,
    take: bridge.take,
    retry: bridge.retry,
  };
}
