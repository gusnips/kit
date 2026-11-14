/**
 * One push to every phone a person has, through the right transport for each.
 *
 * What it does not decide is which pushes to send. Categories, preferences and a person's mute
 * are each product's policy, so the app asks those before it calls `send`.
 */
import type { Logger } from "../../logger/index.ts";
import { attemptOf, failedSend } from "./attempt.ts";
import type {
  PushAttempt,
  PushContent,
  PushPlatform,
  PushSendResult,
  PushTransport,
} from "./types.ts";

export interface PushDevice {
  token: string;
  platform: PushPlatform;
}

/** Your table of devices. The notifier reads it, and removes the tokens a transport calls dead. */
export interface PushDeviceRepository {
  listForUser(userId: string): Promise<PushDevice[]>;
  /** Removes the token, whoever holds it now: a token APNs or FCM called dead is dead for all. */
  remove(token: string): Promise<void>;
}

export interface PushNotifierOptions {
  /**
   * One transport per platform. Leave a platform out when it has no credentials. Its devices are
   * then skipped, never sent through the other platform, where the token would fail and look dead.
   */
  transports: Partial<Record<PushPlatform, PushTransport>>;
  devices: PushDeviceRepository;
  /** Required: `send` never throws, so this is the only place a failed push shows. */
  logger: Pick<Logger, "warn">;
  /**
   * Called once per request a transport made, for your traces and metrics: twice for an APNs
   * token that production sent on to sandbox. A device on a platform with no transport makes no
   * request and no call. It is called after the token is removed, so the last attempt can say so.
   * It runs inline, so keep it quick: a promise it returns is never awaited, and a throw or a
   * rejection is logged and dropped.
   */
  onAttempt?: (event: PushAttemptEvent) => void;
}

/** One request, with what the notifier knows beside it. Like `PushAttempt`, it holds no token. */
export type PushAttemptEvent = PushAttempt & {
  platform: PushPlatform;
  /**
   * True on a device's last attempt when its answer removed the token and the removal went
   * through. False on every other attempt, and when the removal failed.
   */
  tokenRemoved: boolean;
};

/**
 * How one `send` went, across the person's devices.
 *
 * - `sent`: at least one device got it, and the rest were dead tokens, now removed.
 * - `unregistered`: every token was dead, and all were removed.
 * - `partial`: at least one device failed or has no transport, but not every device failed and
 *   not every one lacks a transport.
 * - `failed`: every device failed, or the device list could not be read.
 * - `unconfigured`: every device is on a platform with no transport.
 * - `no-devices`: the person has none.
 */
export type PushOutcome =
  | "sent"
  | "unregistered"
  | "partial"
  | "failed"
  | "unconfigured"
  | "no-devices";

export interface PushNotifier {
  /** Sends to every device the person has. Never throws, so `void notifier.send(...)` is safe. */
  send(userId: string, content: PushContent): Promise<PushOutcome>;
}

type DeviceOutcome = PushSendResult["status"] | "unconfigured";

/**
 *     const push = createPushNotifier({
 *       transports: { ios: createApnsTransport(apns), android: createFcmTransport(fcm) },
 *       devices: pushDevices,
 *       logger,
 *     });
 *     void push.send(userId, { title: "Your report is ready", data: { reportId } });
 */
export function createPushNotifier(options: PushNotifierOptions): PushNotifier {
  const { transports, devices, logger, onAttempt } = options;

  function observe(event: PushAttemptEvent): void {
    const dropped = (error: unknown) =>
      logger.warn("Push onAttempt hook failed, and the push went on", { error });
    try {
      const returned: unknown = onAttempt?.(event);
      if (returned instanceof Promise) returned.catch(dropped);
    } catch (error) {
      dropped(error);
    }
  }

  async function toDevice(device: PushDevice, content: PushContent): Promise<DeviceOutcome> {
    const { platform, token } = device;
    const transport = transports[platform];
    // No credentials for this platform: the configuration, not a failure worth a line per push.
    if (!transport) return "unconfigured";
    const startedAt = Date.now();
    let result: PushSendResult;
    try {
      result = await transport.send({ ...content, token });
      if (result.status === "failed")
        logger.warn("Push not delivered", { platform, reason: result.reason });
    } catch (error) {
      // A transport of the app's own may throw. One device failing must not stop the others.
      logger.warn("Push not delivered: the transport threw", { platform, error });
      result = failedSend(String(error), startedAt);
    }
    // A transport of the app's own may count nothing. Its send was then one attempt.
    const attempts = result.attempts ?? [attemptOf(result, startedAt)];
    let tokenRemoved = false;
    if (result.status === "unregistered") {
      // The only sure sign the app is gone from that phone, so it is acted on at once.
      try {
        await devices.remove(token);
        tokenRemoved = true;
      } catch (error) {
        logger.warn("Push token is dead, and removing it failed", { platform, error });
      }
    }
    const last = attempts.length - 1;
    attempts.forEach((attempt, index) =>
      observe({ ...attempt, platform, tokenRemoved: tokenRemoved && index === last }),
    );
    return result.status;
  }

  return {
    async send(userId, content) {
      let list: PushDevice[];
      try {
        list = await devices.listForUser(userId);
      } catch (error) {
        logger.warn("Push not sent: the person's devices could not be read", { error });
        return "failed";
      }
      if (list.length === 0) return "no-devices";
      const outcomes = await Promise.all(list.map((device) => toDevice(device, content)));
      if (outcomes.every((outcome) => outcome === "unconfigured")) return "unconfigured";
      if (outcomes.every((outcome) => outcome === "failed")) return "failed";
      if (outcomes.some((outcome) => outcome === "failed" || outcome === "unconfigured"))
        return "partial";
      return outcomes.includes("sent") ? "sent" : "unregistered";
    },
  };
}
