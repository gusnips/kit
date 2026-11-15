/**
 * Everything about a phone's Turnstile check that is not React or the WebView itself: the token
 * rules (the web ones, from `@gusnips/react/turnstile-machine`), the lock on the WebView, and the
 * reading of what the page says. It imports no `react-native` module, so a test drives it with a
 * fake WebView: call the props it hands out, the way the real one would.
 *
 * One WebView lives for one round, because the check cannot reset a widget in place and a round
 * ends the moment a token is taken. A new round is a new `key`, so React mounts a fresh WebView and
 * nothing from the old page can answer for the new one.
 *
 * Nothing here logs, stores or returns a token except to the single `take()` waiting for it.
 */
import {
  createTurnstileMachine,
  TURNSTILE_ORIGIN,
  type TurnstileRound,
  type TurnstileState,
} from "@gusnips/react/turnstile-machine";
import { MESSAGE_VERSION, PAGE_SIGNALS, turnstilePage, type PageSignal } from "./turnstile-page.ts";

/** How long a page gets to answer once. Cloudflare's script and a slow network both fit. */
const LOAD_TIMEOUT_MS = 30_000;
/** Cloudflare tokens are at most 2048 characters. A longer one is not from Cloudflare. */
const MAX_TOKEN_CHARS = 2048;
const MAX_MESSAGE_CHARS = 4096;

export interface NativeTurnstileOptions {
  /** Public widget key. Unset means off, not that server protection is active. */
  siteKey: string | undefined;
  /** A server-owned name for this form, such as "signin" or "contact". */
  action: string;
  /**
   * The https address Cloudflare knows this widget by, such as `https://app.example.com`. The page
   * is loaded as if it came from there, so it must be a hostname the widget allows and, when your
   * API verifies the token, one of the verifier's `hostnames`. It may be unset while `siteKey` is.
   */
  origin: string | undefined;
  language?: string;
  theme?: "auto" | "light" | "dark";
  /**
   * Mount the WebView as soon as the screen does. Off by default, unlike the web hook: a WebView is
   * costly on a phone, and nothing may contact Cloudflare before the person acts. The first take()
   * or retry() starts the check. Turn it on for a screen whose first press must not wait.
   */
  eager?: boolean;
}

export interface NavigationRequest {
  url: string;
  /** iOS says so for a frame inside the page. Android reports only the page itself. */
  isTopFrame?: boolean;
}

export interface WebViewMessage {
  nativeEvent: { data: string; url: string };
}

/** What the check sets on the WebView. Every field is one react-native-webview accepts. */
export interface TurnstileWebViewProps {
  source: { html: string; baseUrl: string };
  originWhitelist: string[];
  onShouldStartLoadWithRequest: (request: NavigationRequest) => boolean;
  onMessage: (event: WebViewMessage) => void;
  javaScriptEnabled: true;
  allowFileAccess: false;
  allowFileAccessFromFileURLs: false;
  allowUniversalAccessFromFileURLs: false;
  mixedContentMode: "never";
  setSupportMultipleWindows: false;
  javaScriptCanOpenWindowsAutomatically: false;
  allowsLinkPreview: false;
  scrollEnabled: false;
}

export interface TurnstileView {
  /** New for every round. Put it on the element so React mounts a fresh WebView. */
  key: string;
  /** True while Cloudflare needs the person. Otherwise the WebView stays out of sight. */
  shown: boolean;
  props: TurnstileWebViewProps;
}

export interface TurnstileSnapshot {
  state: TurnstileState;
  /** Null while no round runs: off, idle, failed, unavailable, unsupported. */
  view: TurnstileView | null;
}

export interface TurnstileBridge {
  attach: () => void;
  detach: () => void;
  take: () => Promise<string | undefined>;
  retry: () => void;
  getSnapshot: () => TurnstileSnapshot;
  subscribe: (listener: () => void) => () => void;
}

/**
 * `https://host` or `https://host:port`, nothing after it, in lower case. A path, a query, a login
 * or a plain `http` address is not an origin Cloudflare checks a widget against.
 */
export function normalizeOrigin(input: string): string | null {
  const match =
    /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?)\/?$/i.exec(
      input,
    );
  return match?.[1] ? `https://${match[1].toLowerCase()}` : null;
}

/**
 * The origin of an http or https address, or null for anything else. Read by hand because
 * React Native's `URL` has no `origin`. An address with a login in it (`https://good@evil.test`)
 * or a backslash is refused rather than guessed at.
 */
export function originOf(url: string): string | null {
  const match = /^(https?):\/\/([^/?#@\\]+)(?=[/?#]|$)/i.exec(url);
  return match?.[1] && match[2] ? `${match[1]}://${match[2]}`.toLowerCase() : null;
}

/**
 * May the WebView load this? Its own page, and the Cloudflare frame inside it. Everything else,
 * including a link tapped in the widget, a file, a script address and another app's scheme, is
 * refused here. react-native-webview's `originWhitelist` cannot do this job: it hands every
 * address it rejects to the phone to open, which is a way out of the lock, not a wall.
 */
export function allowsNavigation(request: NavigationRequest, origin: string): boolean {
  const { url } = request;
  if (url === "about:blank" || url === "about:srcdoc") return true;
  const where = originOf(url);
  if (where === null) return false;
  if (request.isTopFrame === false) return where === TURNSTILE_ORIGIN;
  return url === origin || url === `${origin}/`;
}

/**
 * Did this message come from the page we wrote? iOS reports the address the page was loaded as.
 * Android reports `about:blank` for a page loaded from a string. Another http(s) address, the
 * Cloudflare frame included, is not our page.
 */
function isOurPage(url: string, origin: string): boolean {
  return url === "" || url === "about:blank" || originOf(url) === origin;
}

export type TurnstileMessage = { type: "token"; token: string } | { type: PageSignal };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSignal(value: unknown): value is PageSignal {
  return PAGE_SIGNALS.some((signal) => signal === value);
}

/**
 * Read one message from the page, or null when it is not for this round. The nonce is what
 * separates this round from an older one and from any page that is not ours, so a wrong or missing
 * one is dropped without a word. A token that is empty or too long, sent with the right nonce,
 * is the page failing, and says so.
 */
export function parseTurnstileMessage(data: unknown, nonce: string): TurnstileMessage | null {
  if (typeof data !== "string" || data.length > MAX_MESSAGE_CHARS) return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(message) || message.v !== MESSAGE_VERSION || message.nonce !== nonce) return null;
  const { type, token } = message;
  if (type === "token") {
    const usable = typeof token === "string" && token.length > 0 && token.length <= MAX_TOKEN_CHARS;
    return usable ? { type, token } : { type: "failed" };
  }
  return isSignal(type) ? { type } : null;
}

// ponytail: where the runtime has no crypto.getRandomValues, the nonce falls back to Math.random,
// which is guessable. That is enough for what it does there: it tells this round's messages from an
// older round's, and the navigation lock keeps every other page out of the WebView. If a page we
// did not write could ever load here, add a polyfill (react-native-get-random-values) and drop the
// fallback.
function newNonce(): string {
  const source: unknown = Reflect.get(globalThis, "crypto");
  if (isRecord(source) && typeof source.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    source.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

interface ActiveRound {
  nonce: string;
  round: TurnstileRound;
  props: TurnstileWebViewProps;
  /** The page answered, so the load deadline no longer applies. */
  loaded: () => void;
}

export function createTurnstileBridge(options: NativeTurnstileOptions): TurnstileBridge {
  const { action, theme = "auto", language = "auto", eager = false } = options;
  const siteKey = options.siteKey ?? "";
  // Throw while rendering, not at the first sign-in: a wrong origin is a bug in the app's config.
  const origin = siteKey === "" ? "" : requireOrigin(options.origin);
  const listeners = new Set<() => void>();
  let active: ActiveRound | null = null;

  const machine = createTurnstileMachine({
    enabled: siteKey !== "",
    eager,
    driver: (round) => {
      const nonce = newNonce();
      const timer = setTimeout(round.unavailable, LOAD_TIMEOUT_MS);
      const current: ActiveRound = {
        nonce,
        round,
        loaded: () => clearTimeout(timer),
        props: {
          source: {
            html: turnstilePage({
              siteKey,
              action,
              language: language.toLowerCase(),
              theme,
              nonce,
            }),
            baseUrl: `${origin}/`,
          },
          // "*" on purpose, and do not narrow it. react-native-webview opens every address its
          // originWhitelist rejects with Linking.openURL, in the phone's browser or another app
          // (WebViewShared.tsx, createOnShouldStartLoadWithRequest). A narrow list would turn a
          // refused link into a way out of this WebView. allowsNavigation only ever says no.
          originWhitelist: ["*"],
          onShouldStartLoadWithRequest: (request) => allowsNavigation(request, origin),
          onMessage: ({ nativeEvent }) => receive(current, nativeEvent),
          javaScriptEnabled: true,
          allowFileAccess: false,
          allowFileAccessFromFileURLs: false,
          allowUniversalAccessFromFileURLs: false,
          mixedContentMode: "never",
          setSupportMultipleWindows: false,
          javaScriptCanOpenWindowsAutomatically: false,
          allowsLinkPreview: false,
          scrollEnabled: false,
        },
      };
      active = current;
      refresh();
      return () => {
        clearTimeout(timer);
        if (active === current) active = null;
        refresh();
      };
    },
  });

  function receive(current: ActiveRound, event: WebViewMessage["nativeEvent"]) {
    if (active !== current || !isOurPage(event.url, origin)) return;
    const message = parseTurnstileMessage(event.data, current.nonce);
    if (!message) return;
    current.loaded();
    if (message.type === "token") current.round.token(message.token);
    else if (message.type !== "rendered") current.round[message.type]();
  }

  let snapshot: TurnstileSnapshot = { state: machine.getSnapshot(), view: null };
  function refresh() {
    const state = machine.getSnapshot();
    if (state === snapshot.state && active?.nonce === snapshot.view?.key) return;
    snapshot = {
      state,
      view: active && { key: active.nonce, shown: state === "interactive", props: active.props },
    };
    for (const listener of listeners) listener();
  }
  machine.subscribe(refresh);

  return {
    attach: machine.attach,
    detach: machine.detach,
    take: machine.take,
    retry: machine.retry,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function requireOrigin(origin: string | undefined): string {
  const normalized = origin === undefined ? null : normalizeOrigin(origin);
  if (normalized === null) {
    throw new Error(
      'useTurnstile needs origin to be the https address the widget is registered for, such as "https://app.example.com", with no path.',
    );
  }
  return normalized;
}
