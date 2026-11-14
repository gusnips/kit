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

export type PushSendResult =
  | { status: "sent" }
  /** The token is dead: the app was deleted, or reinstalled under a new token. Remove it. */
  | { status: "unregistered" }
  /** Not delivered, and the token may still be good. Keep it. */
  | { status: "failed"; reason: string };

export interface PushTransport {
  /** Sends one push and says how it went. Never throws. */
  send(message: PushMessage): Promise<PushSendResult>;
}
