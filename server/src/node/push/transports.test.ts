import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApnsTransport, createFcmTransport, createPushNotifier } from "./index.ts";
import type { ApnsConfig, PushAttemptEvent, PushDevice, PushMessage } from "./index.ts";
import { createLogger } from "../../logger/index.ts";
import { fcmResult } from "./fcm.ts";

const PRODUCTION = "https://api.push.apple.com";
const SANDBOX = "https://api.sandbox.push.apple.com";
/** Taken before any spy, so a second fake Apple in one test does not call the first. */
const realConnect = http2.connect;

const message: PushMessage = { token: "abc123", title: "Ready", body: "Your report is in" };
/** The two timing fields every attempt carries. */
const timed = { startedAt: expect.any(Number), durationMs: expect.any(Number) };

async function exported(privateKey: Parameters<typeof crypto.subtle.exportKey>[1]) {
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----`;
}

interface TestKey {
  pem: string;
  verify: (jwt: string) => Promise<boolean>;
}
let apple: TestKey;
let google: TestKey;

function verifier(
  algorithm: Parameters<typeof crypto.subtle.verify>[0],
  publicKey: Parameters<typeof crypto.subtle.verify>[1],
) {
  return (jwt: string) => {
    const [header, claims, signature] = jwt.split(".");
    return crypto.subtle.verify(
      algorithm,
      publicKey,
      Buffer.from(signature ?? "", "base64url"),
      Buffer.from(`${header}.${claims}`),
    );
  };
}

beforeAll(async () => {
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  // Written the way a one-line .env holds it: `\n` as two characters.
  const applePem = (await exported(ec.privateKey)).replace(/\n/g, "\\n");
  apple = {
    pem: applePem,
    verify: verifier({ name: "ECDSA", hash: "SHA-256" }, ec.publicKey),
  };
  const rsa = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  google = {
    pem: await exported(rsa.privateKey),
    verify: verifier({ name: "RSASSA-PKCS1-v1_5" }, rsa.publicKey),
  };
});

/** The JWT's two readable parts. */
const decoded = (jwt: string) => {
  const [header, claims] = jwt.split(".").map((part) => Buffer.from(part, "base64url").toString());
  return { header: JSON.parse(header ?? ""), claims: JSON.parse(claims ?? "") };
};

interface Seen {
  origin: string;
  headers: http2.IncomingHttpHeaders;
  body: string;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const step of cleanup.splice(0)) await step();
});

/**
 * Apple's two environments as two local HTTP/2 servers, each answering what it is given.
 * `http2.connect` is pointed at them, so the transport's real requests go over the wire.
 */
async function fakeApple(answers: Partial<Record<string, { status: number; reason?: string }>>) {
  const seen: Seen[] = [];
  const ports: Record<string, number> = {};
  for (const origin of [PRODUCTION, SANDBOX]) {
    const server = http2.createServer();
    server.on("stream", (stream, headers) => {
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => (body += chunk));
      stream.on("end", () => {
        seen.push({ origin, headers, body });
        const answer = answers[origin] ?? { status: 500 };
        stream.respond({ ":status": answer.status });
        stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : "");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    ports[origin] = (server.address() as AddressInfo).port;
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }
  const sessions: http2.ClientHttp2Session[] = [];
  // Sessions first, or `server.close` waits for them.
  cleanup.unshift(() => sessions.forEach((session) => session.destroy()));
  vi.spyOn(http2, "connect").mockImplementation((authority: string | URL) => {
    const session = realConnect(`http://127.0.0.1:${ports[String(authority)]}`);
    sessions.push(session);
    return session;
  });
  return seen;
}

function apns(overrides: Partial<ApnsConfig> = {}) {
  return createApnsTransport({
    privateKeyPem: apple.pem,
    keyId: "KEY123",
    teamId: "TEAM123",
    bundleId: "com.acme.app",
    ...overrides,
  });
}

describe("createApnsTransport", () => {
  it("sends a production token once, signed with the key and addressed to the app", async () => {
    const seen = await fakeApple({ [PRODUCTION]: { status: 200 } });

    const result = await apns().send({
      ...message,
      badge: 3,
      data: { screen: "report", aps: "x" },
    });

    expect(result).toEqual({
      status: "sent",
      attempts: [{ environment: "production", httpStatus: 200, result: "sent", ...timed }],
    });
    expect(seen.map((request) => request.origin)).toEqual([PRODUCTION]);
    const { headers, body } = seen[0]!;
    expect(headers).toMatchObject({
      ":path": "/3/device/abc123",
      "apns-topic": "com.acme.app",
      "apns-push-type": "alert",
      "apns-priority": "10",
    });
    const jwt = String(headers.authorization).replace(/^bearer /, "");
    expect(await apple.verify(jwt)).toBe(true);
    expect(decoded(jwt)).toEqual({
      header: { alg: "ES256", kid: "KEY123" },
      claims: { iss: "TEAM123", iat: expect.any(Number) },
    });
    // `aps` is APNs' own key, so a data key of that name cannot replace the alert.
    expect(JSON.parse(body)).toEqual({
      screen: "report",
      aps: {
        alert: { title: "Ready", body: "Your report is in" },
        sound: "default",
        badge: 3,
      },
    });
  });

  it("tries sandbox for a debug build's token, and calls it dead only when both refuse it", async () => {
    const seen = await fakeApple({
      [PRODUCTION]: { status: 400, reason: "BadDeviceToken" },
      [SANDBOX]: { status: 200 },
    });
    expect(await apns().send(message)).toMatchObject({ status: "sent" });
    expect(seen.map((request) => request.origin)).toEqual([PRODUCTION, SANDBOX]);

    await fakeApple({
      [PRODUCTION]: { status: 400, reason: "BadDeviceToken" },
      [SANDBOX]: { status: 400, reason: "BadDeviceToken" },
    });
    expect(await apns().send(message)).toMatchObject({ status: "unregistered" });
  });

  it("calls a 410 dead without asking sandbox, and keeps a token Apple says is for another app", async () => {
    const gone = await fakeApple({ [PRODUCTION]: { status: 410, reason: "Unregistered" } });
    expect(await apns().send(message)).toMatchObject({ status: "unregistered" });
    expect(gone.map((request) => request.origin)).toEqual([PRODUCTION]);

    // A wrong bundleId can draw this for every device, so it must not remove them all.
    await fakeApple({ [PRODUCTION]: { status: 400, reason: "DeviceTokenNotForTopic" } });
    expect(await apns().send(message)).toMatchObject({
      status: "failed",
      reason: "400 DeviceTokenNotForTopic",
    });
  });

  it("signs one provider token for a burst, and a key that does not import never reaches Apple", async () => {
    const seen = await fakeApple({ [PRODUCTION]: { status: 200 } });
    const transport = apns();
    const burst = ["a", "b", "c", "d"].map((token) => transport.send({ ...message, token }));
    expect((await Promise.all(burst)).map((result) => result.status)).toEqual(
      Array(4).fill("sent"),
    );
    expect(new Set(seen.map((request) => request.headers.authorization)).size).toBe(1);

    const result = await apns({ privateKeyPem: "not a key" }).send(message);
    const reason = expect.stringMatching(/^provider token: /);
    // No request went out, so the attempt names no environment and no status.
    expect(result).toEqual({
      status: "failed",
      reason,
      attempts: [{ result: "failed", reason, ...timed }],
    });
    expect(seen).toHaveLength(4);
  });

  it("answers a refused connection as a failed send, and the process lives", async () => {
    // With no `error` listener on the session this ends the process, so vitest fails the run.
    vi.spyOn(http2, "connect").mockImplementation(() => realConnect("http://127.0.0.1:1"));

    const result = await apns().send(message);

    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("ECONNREFUSED"),
    });
  });
});

describe("createFcmTransport", () => {
  it("reads an FCM answer as dead only when it says UNREGISTERED", () => {
    const unregistered = JSON.stringify({
      error: {
        code: 404,
        status: "NOT_FOUND",
        details: [
          {
            "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
            errorCode: "UNREGISTERED",
          },
        ],
      },
    });
    expect(fcmResult(200, "{}")).toEqual({ status: "sent" });
    expect(fcmResult(404, unregistered)).toEqual({ status: "unregistered" });
    // A 404 with no code may be our own project id: never a reason to remove every device.
    expect(fcmResult(404, '{"error":{"status":"NOT_FOUND"}}')).toMatchObject({ status: "failed" });
    expect(fcmResult(400, '{"error":{"status":"INVALID_ARGUMENT"}}')).toMatchObject({
      status: "failed",
    });
  });

  it("trades the service account for one token per burst, and sends a notification Android shows", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      if (String(url) === "https://oauth2.googleapis.com/token")
        return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3599 }));
      return new Response(JSON.stringify({ name: "projects/acme/messages/1" }));
    });
    const transport = createFcmTransport({
      projectId: "acme",
      clientEmail: "push@acme.iam.gserviceaccount.com",
      privateKeyPem: google.pem,
    });

    const burst = ["a", "b", "c"].map((token) =>
      transport.send({ ...message, token, data: { screen: "report" } }),
    );
    const results = await Promise.all(burst);
    expect(results.map((result) => result.status)).toEqual(Array(3).fill("sent"));
    expect(results[0]?.attempts).toEqual([{ httpStatus: 200, result: "sent", ...timed }]);

    const exchanges = calls.filter((call) => call.url === "https://oauth2.googleapis.com/token");
    expect(exchanges).toHaveLength(1);
    const assertion = new URLSearchParams(exchanges[0]!.body).get("assertion") ?? "";
    expect(await google.verify(assertion)).toBe(true);
    expect(decoded(assertion)).toEqual({
      header: { alg: "RS256", typ: "JWT" },
      claims: {
        iss: "push@acme.iam.gserviceaccount.com",
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: expect.any(Number),
        exp: expect.any(Number),
      },
    });

    const sends = calls.filter((call) => call.url.endsWith("/messages:send"));
    expect(sends.map((call) => call.url)).toEqual(
      Array(3).fill("https://fcm.googleapis.com/v1/projects/acme/messages:send"),
    );
    expect(JSON.parse(sends[0]!.body)).toEqual({
      message: {
        token: "a",
        notification: { title: "Ready", body: "Your report is in" },
        data: { screen: "report" },
        android: { priority: "HIGH", notification: { default_sound: true } },
      },
    });
  });
});

describe("onAttempt", () => {
  function observed(removeFails = false) {
    const events: PushAttemptEvent[] = [];
    const removed: string[] = [];
    const push = createPushNotifier({
      transports: { ios: apns() },
      devices: {
        listForUser: async () => [{ token: "abc123", platform: "ios" }],
        remove: async (token) => {
          if (removeFails) throw new Error("connection refused");
          removed.push(token);
        },
      },
      logger: { warn: () => {} },
      onAttempt: (event) => events.push(event),
    });
    return { push, events, removed };
  }

  it("is called once per request, the sandbox retry included", async () => {
    await fakeApple({
      [PRODUCTION]: { status: 400, reason: "BadDeviceToken" },
      [SANDBOX]: { status: 200 },
    });
    const { push, events } = observed();

    expect(await push.send("u1", { title: "Ready" })).toBe("sent");
    expect(events).toEqual([
      {
        platform: "ios",
        environment: "production",
        httpStatus: 400,
        result: "wrong-environment",
        tokenRemoved: false,
        ...timed,
      },
      {
        platform: "ios",
        environment: "sandbox",
        httpStatus: 200,
        result: "sent",
        tokenRemoved: false,
        ...timed,
      },
    ]);
  });

  it("says on the last request that the token was removed, and never carries the token", async () => {
    const both = { status: 400, reason: "BadDeviceToken" };
    await fakeApple({ [PRODUCTION]: both, [SANDBOX]: both });
    const { push, events, removed } = observed();

    expect(await push.send("u1", { title: "Ready" })).toBe("unregistered");
    expect(removed).toEqual(["abc123"]);
    expect(events.map(({ environment, tokenRemoved }) => ({ environment, tokenRemoved }))).toEqual([
      { environment: "production", tokenRemoved: false },
      { environment: "sandbox", tokenRemoved: true },
    ]);
    expect(JSON.stringify(events)).not.toContain("abc123");

    // A removal that failed is not reported as done.
    const stuck = observed(true);
    expect(await stuck.push.send("u1", { title: "Ready" })).toBe("unregistered");
    expect(stuck.events.map((event) => event.tokenRemoved)).toEqual([false, false]);
  });
});

describe("README: phone push", () => {
  it("pushes to the person's iPhone, and skips the platform with no transport", async () => {
    const seen = await fakeApple({ [PRODUCTION]: { status: 200 } });
    const env = {
      APNS_PRIVATE_KEY: apple.pem,
      APNS_KEY_ID: "KEY123",
      APNS_TEAM_ID: "TEAM123",
      FCM_SERVICE_ACCOUNT: "",
    };
    const table: (PushDevice & { userId: string })[] = [
      { userId: "u1", token: "abc123", platform: "ios" },
      { userId: "u1", token: "pixel", platform: "android" },
    ];
    const pushDevices = {
      listForUser: async (userId: string) => table.filter((row) => row.userId === userId),
      remove: async () => {},
    };
    const warnings: string[] = [];
    const logger = { warn: (line: string) => warnings.push(line) };

    const account = env.FCM_SERVICE_ACCOUNT ? JSON.parse(env.FCM_SERVICE_ACCOUNT) : undefined;
    const push = createPushNotifier({
      transports: {
        ios: createApnsTransport({
          privateKeyPem: env.APNS_PRIVATE_KEY,
          keyId: env.APNS_KEY_ID,
          teamId: env.APNS_TEAM_ID,
          bundleId: "com.acme.app",
        }),
        ...(account && {
          android: createFcmTransport({
            projectId: account.project_id,
            clientEmail: account.client_email,
            privateKeyPem: account.private_key,
          }),
        }),
      },
      devices: pushDevices,
      logger,
    });

    expect(await push.send("u1", { title: "Your report is ready", data: { reportId: "r1" } })).toBe(
      "partial",
    );
    expect(seen.map((request) => request.headers[":path"])).toEqual(["/3/device/abc123"]);
    expect(warnings).toEqual([]);
  });

  it("logs one line per request from onAttempt, with no token in it", async () => {
    await fakeApple({
      [PRODUCTION]: { status: 400, reason: "BadDeviceToken" },
      [SANDBOX]: { status: 200 },
    });
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    const transports = { ios: apns() };
    const device: PushDevice = { token: "abc123", platform: "ios" };
    const pushDevices = { listForUser: async () => [device], remove: async () => {} };

    const push = createPushNotifier({
      transports,
      devices: pushDevices,
      logger,
      onAttempt: (attempt) => logger.info("Push request", attempt),
    });

    expect(await push.send("u1", { title: "Ready" })).toBe("sent");
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged).toMatchObject([
      { message: "Push request", environment: "production", result: "wrong-environment" },
      { message: "Push request", environment: "sandbox", result: "sent" },
    ]);
    expect(lines.join("")).not.toContain("abc123");
  });
});
