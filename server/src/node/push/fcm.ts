/**
 * Push to Android through FCM's HTTP v1 API, with no SDK: firebase-admin exists to do one OAuth
 * exchange and one POST, and both are below, on `fetch` and Web Crypto.
 *
 * One file holds both credentials: a Firebase service account's JSON carries the project id, the
 * account's address and its RSA key.
 */
import { attemptOf, failedSend } from "./attempt.ts";
import { jwtSigner } from "./jwt.ts";
import type { PushSendResult, PushTransport } from "./types.ts";

export interface FcmConfig {
  /** `project_id` in the service account's JSON file. */
  projectId: string;
  /** `client_email` in that file. */
  clientEmail: string;
  /** `private_key` in that file, a PKCS #8 PEM. */
  privateKeyPem: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** Google's access tokens last an hour; take a new one a few minutes early. */
const TOKEN_TTL_MS = 55 * 60 * 1000;
const TIMEOUT_MS = 10_000;

/**
 * What one FCM answer means for the token. Only `UNREGISTERED` removes it, and FCM sends that with
 * a 404. The donor also removed on any 404, but a 404 without the code may name something of
 * ours, such as a wrong project id, and removing on it would delete every Android registration.
 * Not measured against Google; the narrow rule can only keep a token, never delete a good one.
 * A 400 is our request (a reserved `data` key, a token too malformed to parse), never a dead device.
 */
export function fcmResult(status: number, body: string): PushSendResult {
  if (status >= 200 && status < 300) return { status: "sent" };
  if (status === 404 && body.includes('"UNREGISTERED"')) return { status: "unregistered" };
  return { status: "failed", reason: `${status} ${body.slice(0, 200)}`.trim() };
}

/**
 *     const account = JSON.parse(env.FCM_SERVICE_ACCOUNT);
 *     const android = createFcmTransport({
 *       projectId: account.project_id,
 *       clientEmail: account.client_email,
 *       privateKeyPem: account.private_key,
 *     });
 *
 * Make one per process and keep it: it holds the access token for an hour.
 */
export function createFcmTransport(config: FcmConfig): PushTransport {
  for (const field of ["projectId", "clientEmail", "privateKeyPem"] as const)
    if (!config[field]) throw new TypeError(`createFcmTransport needs ${field}, and it is empty`);

  const accessToken = googleAccessToken(config);
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`;

  return {
    async send(message) {
      const startedAt = Date.now();
      let bearer: string;
      try {
        bearer = await accessToken();
      } catch (error) {
        return failedSend(`access token: ${String(error)}`, startedAt);
      }
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              token: message.token,
              // The `notification` block lets the system show the push and open the app on a tap
              // while the app is in the background, with nothing of ours running. `data` arrives
              // with the tap.
              notification: {
                title: message.title,
                ...(message.body ? { body: message.body } : {}),
              },
              data: message.data,
              // HIGH carries the push through Doze, Android's battery saver.
              android: { priority: "HIGH", notification: { default_sound: true } },
            },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const result = fcmResult(response.status, await response.text());
        return {
          ...result,
          attempts: [attemptOf(result, startedAt, { httpStatus: response.status })],
        };
      } catch (error) {
        return failedSend(String(error), startedAt);
      }
    },
  };
}

/**
 * A bearer token for FCM, from the service account: sign a JWT with its key, trade it at Google's
 * token endpoint, keep it for 55 minutes.
 *
 * The exchange itself is kept while it runs, not only its answer: a burst calls this once per
 * device at the same moment, and keeping only the answer would have each call sign and trade its
 * own. A failed exchange is dropped, so the next send tries again.
 */
function googleAccessToken(config: FcmConfig): () => Promise<string> {
  const sign = jwtSigner(config.privateKeyPem, "RS256");
  let cached: { value: string; until: number } | undefined;
  let inFlight: Promise<string> | undefined;

  async function exchange(): Promise<string> {
    const now = Date.now();
    const iat = Math.floor(now / 1000);
    const assertion = await sign(
      { typ: "JWT" },
      { iss: config.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 },
    );
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `Google refused the service account: ${response.status} ${text.slice(0, 200)}`,
      );
    const answer: unknown = JSON.parse(text);
    const value =
      typeof answer === "object" && answer !== null && "access_token" in answer
        ? answer.access_token
        : undefined;
    if (typeof value !== "string" || !value)
      throw new Error("Google's token answer has no access_token");
    cached = { value, until: now + TOKEN_TTL_MS };
    return value;
  }

  return () => {
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.value);
    inFlight ??= exchange().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
