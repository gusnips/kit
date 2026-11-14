import { describe, expect, it } from "vitest";
import { createPushNotifier } from "./index.ts";
import type {
  PushAttemptEvent,
  PushDevice,
  PushMessage,
  PushSendResult,
  PushTransport,
} from "./index.ts";

const IPHONE: PushDevice = { token: "tok-iphone", platform: "ios" };
const IPAD: PushDevice = { token: "tok-ipad", platform: "ios" };
const PIXEL: PushDevice = { token: "tok-pixel", platform: "android" };

function deviceTable(
  list: PushDevice[],
  options: { listFails?: boolean; removeFails?: boolean } = {},
) {
  const removed: string[] = [];
  return {
    removed,
    listForUser: async () => {
      if (options.listFails) throw new Error("connection refused");
      return list;
    },
    remove: async (token: string) => {
      if (options.removeFails) throw new Error("connection refused");
      removed.push(token);
    },
  };
}

/** A transport that answers each token from `answers`, and "sent" for any other. */
function fakeTransport(answers: Record<string, PushSendResult | "throw"> = {}) {
  const sent: PushMessage[] = [];
  const transport: PushTransport & { sent: PushMessage[] } = {
    sent,
    send: async (message) => {
      sent.push(message);
      const answer = answers[message.token] ?? { status: "sent" };
      if (answer === "throw") throw new Error("socket closed");
      return answer;
    },
  };
  return transport;
}

function logger() {
  const lines: { message: string; meta: unknown }[] = [];
  return { lines, warn: (message: string, meta?: unknown) => lines.push({ message, meta }) };
}

describe("createPushNotifier", () => {
  it("sends each device through its own platform's transport, with its own token", async () => {
    const ios = fakeTransport();
    const android = fakeTransport();
    const push = createPushNotifier({
      transports: { ios, android },
      devices: deviceTable([IPHONE, IPAD, PIXEL]),
      logger: logger(),
    });

    const outcome = await push.send("u1", { title: "Ready", data: { reportId: "r1" } });

    expect(outcome).toBe("sent");
    expect(ios.sent).toEqual([
      { title: "Ready", data: { reportId: "r1" }, token: "tok-iphone" },
      { title: "Ready", data: { reportId: "r1" }, token: "tok-ipad" },
    ]);
    expect(android.sent.map((message) => message.token)).toEqual(["tok-pixel"]);
  });

  it("removes a token the transport calls dead, and keeps one that only failed", async () => {
    const devices = deviceTable([IPHONE, IPAD]);
    const log = logger();
    const push = createPushNotifier({
      transports: {
        ios: fakeTransport({
          "tok-iphone": { status: "unregistered" },
          "tok-ipad": { status: "failed", reason: "503 ServiceUnavailable" },
        }),
      },
      devices,
      logger: log,
    });

    expect(await push.send("u1", { title: "Ready" })).toBe("partial");
    expect(devices.removed).toEqual(["tok-iphone"]);
    expect(log.lines).toEqual([
      {
        message: "Push not delivered",
        meta: { platform: "ios", reason: "503 ServiceUnavailable" },
      },
    ]);
  });

  it("keeps sending to the other devices when one transport throws", async () => {
    const android = fakeTransport();
    const log = logger();
    const push = createPushNotifier({
      transports: { ios: fakeTransport({ "tok-iphone": "throw" }), android },
      devices: deviceTable([IPHONE, PIXEL]),
      logger: log,
    });

    expect(await push.send("u1", { title: "Ready" })).toBe("partial");
    expect(android.sent.map((message) => message.token)).toEqual(["tok-pixel"]);
    expect(log.lines.map((line) => line.message)).toEqual([
      "Push not delivered: the transport threw",
    ]);
  });

  it("skips a platform with no transport, and never sends its token through the other", async () => {
    // An iOS token handed to FCM fails for good and looks exactly like a dead device.
    const ios = fakeTransport();
    const devices = deviceTable([IPHONE, PIXEL]);
    const push = createPushNotifier({ transports: { ios }, devices, logger: logger() });

    expect(await push.send("u1", { title: "Ready" })).toBe("partial");
    expect(ios.sent.map((message) => message.token)).toEqual(["tok-iphone"]);
    expect(devices.removed).toEqual([]);

    const androidOnly = createPushNotifier({
      transports: { ios },
      devices: deviceTable([PIXEL]),
      logger: logger(),
    });
    expect(await androidOnly.send("u1", { title: "Ready" })).toBe("unconfigured");
  });

  it("never throws: not when the devices cannot be read, nor when a dead token cannot be removed", async () => {
    const log = logger();
    const unreadable = createPushNotifier({
      transports: { ios: fakeTransport() },
      devices: deviceTable([IPHONE], { listFails: true }),
      logger: log,
    });
    expect(await unreadable.send("u1", { title: "Ready" })).toBe("failed");

    const stuck = createPushNotifier({
      transports: { ios: fakeTransport({ "tok-iphone": { status: "unregistered" } }) },
      devices: deviceTable([IPHONE], { removeFails: true }),
      logger: log,
    });
    expect(await stuck.send("u1", { title: "Ready" })).toBe("unregistered");
    expect(log.lines.map((line) => line.message)).toEqual([
      "Push not sent: the person's devices could not be read",
      "Push token is dead, and removing it failed",
    ]);
  });

  it("says when the person has no devices, and when every token was dead", async () => {
    const none = createPushNotifier({
      transports: { ios: fakeTransport() },
      devices: deviceTable([]),
      logger: logger(),
    });
    expect(await none.send("u1", { title: "Ready" })).toBe("no-devices");

    const dead = { status: "unregistered" } as const;
    const devices = deviceTable([IPHONE, IPAD]);
    const gone = createPushNotifier({
      transports: { ios: fakeTransport({ "tok-iphone": dead, "tok-ipad": dead }) },
      devices,
      logger: logger(),
    });
    expect(await gone.send("u1", { title: "Ready" })).toBe("unregistered");
    expect(devices.removed).toEqual(["tok-iphone", "tok-ipad"]);
  });
});

/** Throws on iOS. On Android it rejects, which must be caught, or vitest fails the run on it. */
function failingHook(event: PushAttemptEvent): Promise<void> | undefined {
  if (event.platform === "ios") throw new Error("exporter is down");
  return Promise.reject(new Error("exporter is down"));
}

describe("createPushNotifier: onAttempt", () => {
  it("keeps the push going when the hook throws or its promise rejects", async () => {
    const ios = fakeTransport();
    const android = fakeTransport();
    const log = logger();
    const push = createPushNotifier({
      transports: { ios, android },
      devices: deviceTable([IPHONE, PIXEL]),
      logger: log,
      onAttempt: failingHook,
    });

    expect(await push.send("u1", { title: "Ready" })).toBe("sent");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ios.sent).toHaveLength(1);
    expect(android.sent).toHaveLength(1);
    expect(log.lines.map((line) => line.message)).toEqual([
      "Push onAttempt hook failed, and the push went on",
      "Push onAttempt hook failed, and the push went on",
    ]);
  });

  it("counts one attempt for a transport that reports none, and none for a missing platform", async () => {
    const events: unknown[] = [];
    const devices = deviceTable([IPHONE, PIXEL]);
    const push = createPushNotifier({
      transports: { ios: fakeTransport({ "tok-iphone": { status: "unregistered" } }) },
      devices,
      logger: logger(),
      onAttempt: (event) => events.push(event),
    });

    expect(await push.send("u1", { title: "Ready" })).toBe("partial");
    expect(events).toEqual([
      {
        platform: "ios",
        result: "unregistered",
        tokenRemoved: true,
        startedAt: expect.any(Number),
        durationMs: expect.any(Number),
      },
    ]);
  });
});
