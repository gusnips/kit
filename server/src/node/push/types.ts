/** The two platforms a phone push goes through: APNs for iOS, FCM for Android. */
export type PushPlatform = "ios" | "android";

/** What a push says. The notifier adds each device's token. */
export interface PushContent {
  title: string;
  /** Left out, the push shows the title alone. */
  body?: string | null;
  /**
   * Strings your app reads when the person taps the push, such as which screen to open. On iOS
   * they sit beside `aps`, so a key named `aps` is dropped. FCM's docs reserve `from`,
   * `message_type` and keys starting with `google.` or `gcm.`; leave those out too.
   */
  data?: Record<string, string>;
  /** The number on the app's icon, on iOS only. Left out, the icon keeps the number it has. */
  badge?: number;
}

/** One push to one device. */
export interface PushMessage extends PushContent {
  token: string;
}

export type PushSendResult = (
  | { status: "sent" }
  /** The token is dead: the app was deleted, or reinstalled under a new token. Remove it. */
  | { status: "unregistered" }
  /** Not delivered, and the token may still be good. Keep it. */
  | { status: "failed"; reason: string }
) & {
  /**
   * The requests behind this answer, in order: two for an APNs token that production sent on to
   * sandbox. A transport of your own may leave it out, and the notifier then counts one.
   */
  attempts?: PushAttempt[];
};

/**
 * One request a transport made for one push. It holds no token, not even a hash: a hash is still
 * the same id for the same phone in every trace, which makes a tracing backend a record of devices.
 *
 * A type, not an interface, so it fits a `Record<string, unknown>` (a log line's meta, a span's
 * attributes) with no copy. An interface does not.
 */
export type PushAttempt = {
  /** The APNs environment the request went to. Absent on FCM, and when no request went out. */
  environment?: "production" | "sandbox";
  /** The HTTP status that came back. Absent when none did: a timeout, a refused connection. */
  httpStatus?: number;
  /** What the request said. `wrong-environment` is APNs sending the push on to sandbox. */
  result: PushSendResult["status"] | "wrong-environment";
  /** Why it was not sent, when `result` is `failed`. `timeout` after 10 seconds with no answer. */
  reason?: string;
  /** When it started, in milliseconds since 1970, so a span can be drawn after the fact. */
  startedAt: number;
  durationMs: number;
};

export interface PushTransport {
  /** Sends one push and says how it went. Never throws. */
  send(message: PushMessage): Promise<PushSendResult>;
}
