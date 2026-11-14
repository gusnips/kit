/**
 * Phone push, the `/push` subpath: APNs for iOS, FCM for Android, and a notifier that sends one
 * push to every device a person has and removes the tokens a transport calls dead.
 *
 * Lifted from the one donor with working push. What came across: APNs tried in production and then
 * sandbox, so a debug build's token is not removed; a token removed only on an answer that proves
 * it dead; the signed tokens made once per burst, not once per device; and a send that never
 * throws, because a failed push must not cost the caller the work it was announcing. What stayed in
 * the app: the device table and its routes, push categories and preferences, which events push, and
 * the traces and metrics, which `onAttempt` feeds with one event per request and no token.
 *
 * It lives in `src/node/` because APNs needs `node:http2`. It needs no peer.
 */
export { createApnsTransport } from "./apns.ts";
export type { ApnsConfig } from "./apns.ts";
export { createFcmTransport } from "./fcm.ts";
export type { FcmConfig } from "./fcm.ts";
export { createPushNotifier } from "./notifier.ts";
export type {
  PushAttemptEvent,
  PushDevice,
  PushDeviceRepository,
  PushNotifier,
  PushNotifierOptions,
  PushOutcome,
} from "./notifier.ts";
export type {
  PushAttempt,
  PushContent,
  PushMessage,
  PushPlatform,
  PushSendResult,
  PushTransport,
} from "./types.ts";
