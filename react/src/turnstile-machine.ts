/**
 * The part of a Turnstile check that does not care where the widget runs: which state the check is
 * in, who owns a token, and when a token is too old. A browser drives it with Cloudflare's script
 * (`@gusnips/react/turnstile`) and a phone with a WebView (`@gusnips/native/turnstile`). One copy
 * keeps the rules a token follows from drifting between the two, and a drift here is a token spent
 * twice or a sign-in that waits forever.
 *
 * It reads no browser global and touches no DOM, so a React Native bundle can import it.
 */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** How long one waiting take() lets a round run before it gives up. */
const TOKEN_TIMEOUT_MS = 60_000;
/** Cloudflare expires a token after 300 seconds. A sleeping tab can miss the expired callback. */
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

export type TurnstileErrorReason = "failed" | "unavailable" | "unsupported" | "busy" | "cancelled";

export class TurnstileError extends Error {
  constructor(readonly reason: TurnstileErrorReason) {
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

/** What a driver reports about the round it runs. Once the round has ended, every call is ignored. */
export interface TurnstileRound {
  /** The widget produced a token. An empty one counts as a failure. */
  token: (value: string) => void;
  /** The widget says its token is no longer good. The machine starts a fresh round. */
  expired: () => void;
  /** The widget ran and could not finish. */
  failed: () => void;
  /** The widget never loaded: no script, no network, a blocker in the way. */
  unavailable: () => void;
  /** The environment cannot run the widget at all. Retrying does not help. */
  unsupported: () => void;
  /** The widget needs the person: show it. */
  interactive: () => void;
  /** The person finished, and the widget is working again. */
  afterInteractive: () => void;
}

/**
 * Run one round of the check, and return what stops it. The machine calls the stop once, when the
 * round ends for any reason, and a driver must make it safe to call before the widget has rendered.
 */
export type TurnstileDriver = (round: TurnstileRound) => () => void;

export interface TurnstileMachineOptions {
  /** False when the site key is unset: the check is off and take() answers undefined. */
  enabled: boolean;
  /** Start rounds on attach. False waits for take() or retry(). */
  eager: boolean;
  driver: TurnstileDriver;
}

export interface TurnstileMachine {
  /** The widget has somewhere to live. Starts a round when eager. */
  attach: () => void;
  /** The widget lost its home. Cancels a waiting take() and discards the token. */
  detach: () => void;
  take: () => Promise<string | undefined>;
  retry: () => void;
  getSnapshot: () => TurnstileState;
  subscribe: (listener: () => void) => () => void;
}

interface PendingToken {
  resolve: (token: string) => void;
  reject: (error: TurnstileError) => void;
}

export function createTurnstileMachine({
  enabled,
  eager,
  driver,
}: TurnstileMachineOptions): TurnstileMachine {
  const resting: TurnstileState = enabled ? "idle" : "off";
  let attached = false;
  let state: TurnstileState = resting;
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
    if (!enabled || !attached) return;
    stopRound();
    token = null;
    setState("loading");
    let live = true;
    let stopDriver = () => {};
    // Set before the driver runs: a driver may report from inside its own start.
    stopRound = () => {
      if (!live) return;
      live = false;
      stopDriver();
    };
    const whileLive = (run: () => void) => () => {
      if (live) run();
    };
    const stop = driver({
      token: (value) => {
        if (!live) return;
        if (!value) return fail("failed");
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
      expired: whileLive(start),
      failed: whileLive(() => fail("failed")),
      unavailable: whileLive(() => fail("unavailable")),
      unsupported: whileLive(() => fail("unsupported")),
      interactive: whileLive(() => setState("interactive")),
      afterInteractive: whileLive(() => {
        if (!token) setState("loading");
      }),
    });
    if (live) stopDriver = stop;
    else stop();
  }

  function take(): Promise<string | undefined> {
    if (!enabled) return Promise.resolve(undefined);
    if (!attached) return Promise.reject(new TurnstileError("cancelled"));
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
    attach: () => {
      attached = true;
      if (eager) start();
    },
    detach: () => {
      attached = false;
      fail("cancelled");
      setState(resting);
    },
    take,
    retry: () => {
      if (state !== "unsupported") start();
    },
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
