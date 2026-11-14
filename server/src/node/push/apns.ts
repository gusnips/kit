/**
 * Push to iOS through Apple's own endpoint: an HTTP/2 POST signed with an ES256 JWT. No dependency:
 * `node:http2` and Web Crypto are the whole transport, on Node and on Bun. Firebase can relay to
 * APNs too, but on iOS its SDK brings native pods that broke the donor's React Native build.
 *
 * It lives in `src/node/` because APNs speaks HTTP/2 only, and `fetch` gives no way to ask for it.
 */
import http2 from "node:http2";
import { attemptOf, failedSend } from "./attempt.ts";
import { jwtSigner } from "./jwt.ts";
import type { PushAttempt, PushMessage, PushSendResult, PushTransport } from "./types.ts";

export interface ApnsConfig {
  /** The APNs auth key: the contents of the .p8 file Apple gave you, a PKCS #8 PEM. */
  privateKeyPem: string;
  /** That key's id, from Apple's developer site. */
  keyId: string;
  /** Your Apple team id. */
  teamId: string;
  /** Your app's bundle id. APNs calls it the topic. */
  bundleId: string;
}

const ORIGIN = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;

type Environment = keyof typeof ORIGIN;

/**
 * Apple refuses a provider token older than an hour and asks for a new one no more than every 20
 * minutes, so 50 leaves room on both sides.
 */
const TOKEN_TTL_MS = 50 * 60 * 1000;
const TIMEOUT_MS = 10_000;

/** What one request said: what the push did, or "this token belongs to the other environment". */
export type ApnsAnswer = PushSendResult | { status: "wrong-environment" };

/**
 * What one APNs answer means for the token. Only two answers remove it: a 410, and a token both
 * environments call bad. Every other 400 is our request or our config, not a dead device.
 *
 * That includes `DeviceTokenNotForTopic`, which the donor removed on. A `bundleId` naming another
 * app of the same team can draw it for every device, and removing on it would delete every iOS
 * registration over one typo, which only each person opening the app again can undo. Apple's docs
 * tie an inactive token to 410. The cost: a token from another app's build fails every send.
 */
export function apnsAnswer(status: number, body: string): ApnsAnswer {
  if (status === 200) return { status: "sent" };
  if (status === 410) return { status: "unregistered" };
  const reason = reasonOf(body);
  // A production token sent to sandbox, or the reverse, answers this too.
  if (reason === "BadDeviceToken") return { status: "wrong-environment" };
  return { status: "failed", reason: `${status} ${reason ?? body.slice(0, 200)}`.trim() };
}

/** APNs names the failure in a JSON body, `{"reason":"BadDeviceToken"}`. */
function reasonOf(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "reason" in parsed)
      return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    // Not JSON: an error page in front of APNs. The status and the body's start carry it.
  }
  return undefined;
}

/**
 *     const ios = createApnsTransport({
 *       privateKeyPem: env.APNS_PRIVATE_KEY,
 *       keyId: env.APNS_KEY_ID,
 *       teamId: env.APNS_TEAM_ID,
 *       bundleId: "com.acme.app",
 *     });
 *
 * Make one per process and keep it: it holds one HTTP/2 connection per environment and the signed
 * token, and a transport made per job would sign a new token every time.
 */
export function createApnsTransport(config: ApnsConfig): PushTransport {
  for (const field of ["privateKeyPem", "keyId", "teamId", "bundleId"] as const)
    if (!config[field]) throw new TypeError(`createApnsTransport needs ${field}, and it is empty`);

  const sign = jwtSigner(config.privateKeyPem, "ES256");
  const sessions: Partial<Record<Environment, http2.ClientHttp2Session>> = {};
  let token: { value: Promise<string>; until: number } | undefined;

  /**
   * The promise is kept, not only its value. The donor kept the signed token, so the first burst,
   * one send per device at once, signed one token per device. Apple's limit on refreshing was not
   * measured against that; one signing costs nothing.
   */
  function providerToken(): Promise<string> {
    const now = Date.now();
    if (!token || token.until <= now)
      token = {
        value: sign({ kid: config.keyId }, { iss: config.teamId, iat: Math.floor(now / 1000) }),
        until: now + TOKEN_TTL_MS,
      };
    return token.value;
  }

  function sessionFor(environment: Environment): http2.ClientHttp2Session {
    const open = sessions[environment];
    if (open && !open.closed && !open.destroyed) return open;
    const session = http2.connect(ORIGIN[environment]);
    // Required. With no listener, a refused connect ends the process, even when the stream has
    // its own handler (measured on Node 24.21 and Bun 1.4.2). The stream's error already names
    // the cause ("caused by: connect ECONNREFUSED ..."), so the send's reason carries it.
    session.on("error", () => {});
    sessions[environment] = session;
    return session;
  }

  /** One request: what APNs said, and the attempt it was. */
  function post(
    environment: Environment,
    bearer: string,
    message: PushMessage,
    payload: string,
  ): Promise<{ answer: ApnsAnswer; attempt: PushAttempt }> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let status = 0;
      // `resolve` keeps the first answer and ignores the rest, so a timeout and a late `end` agree.
      const settle = (answer: ApnsAnswer) =>
        resolve({
          answer,
          attempt: attemptOf(answer, startedAt, {
            environment,
            ...(status ? { httpStatus: status } : {}),
          }),
        });
      const session = sessionFor(environment);
      const stream = session.request({
        ":method": "POST",
        // Encoded, because the token comes from whatever a device registered.
        ":path": `/3/device/${encodeURIComponent(message.token)}`,
        authorization: `bearer ${bearer}`,
        "apns-topic": config.bundleId,
        "apns-push-type": "alert",
        // Wake the device now. Without it APNs may hold the push until the device is in use.
        "apns-priority": "10",
        "content-type": "application/json",
      });
      let body = "";
      stream.setEncoding("utf8");
      stream.setTimeout(TIMEOUT_MS, () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        // A connection that died without a word (a NAT that forgot it) keeps `closed` false, so
        // without this every later send would wait its 10 seconds on the same dead socket.
        // ponytail: other sends on this connection fail with it; they were waiting on it too.
        session.destroy();
        settle({ status: "failed", reason: "timeout" });
      });
      stream.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("error", (error) => settle({ status: "failed", reason: error.message }));
      stream.on("end", () => settle(apnsAnswer(status, body)));
      stream.end(payload);
    });
  }

  return {
    async send(message) {
      const startedAt = Date.now();
      let bearer: string;
      try {
        bearer = await providerToken();
      } catch (error) {
        return failedSend(`provider token: ${String(error)}`, startedAt);
      }
      const { title, body, data, badge } = message;
      const payload = JSON.stringify({
        ...data,
        aps: {
          alert: { title, ...(body ? { body } : {}) },
          sound: "default",
          ...(badge === undefined ? {} : { badge }),
        },
      });
      try {
        // A token works only in the environment its build was signed for: App Store and TestFlight
        // builds get production tokens, a debug build from Xcode gets sandbox ones, and nothing on
        // the server tells them apart. So production first, then sandbox. A token is dead only
        // when both refuse it: stopping after the first would remove a working debug device.
        // ponytail: a debug device costs one extra request per push. If that matters, store the
        // environment that answered beside the token.
        const production = await post("production", bearer, message, payload);
        if (production.answer.status !== "wrong-environment")
          return { ...production.answer, attempts: [production.attempt] };
        const sandbox = await post("sandbox", bearer, message, payload);
        const attempts = [production.attempt, sandbox.attempt];
        return sandbox.answer.status === "wrong-environment"
          ? { status: "unregistered", attempts }
          : { ...sandbox.answer, attempts };
      } catch (error) {
        return failedSend(String(error), startedAt);
      }
    },
  };
}
