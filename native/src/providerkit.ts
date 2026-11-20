/**
 * Adapts `@gusnips/native`'s `openSseStream` and `@gusnips/react`'s `ApiClient` to the `open` and
 * `command` functions `@providerkit/native`'s `createSseTransport` asks for.
 *
 * A phone app already has one `SessionAdapter` and one `ApiClient` that own sign-in and
 * single-flight 401 refresh. Building a second stream reader or command sender inside the chat
 * transport would race that refresh on a rotating refresh token and sign the person out. This
 * adapter bridges the two seams without duplicating the transport rules that live in
 * `@providerkit/native`:
 *
 * - `open` opens `openSseStream` with the app's session, forwards each frame's `data`, converts
 *   an `ApiError` into a `TransportError`, and returns `{ abort }`.
 * - `command` calls `client.request` so the same single-flight 401 refresh and `onSessionDead`
 *   latch apply, forwards `AbortSignal`, and turns an `ApiError` into a `TransportError`.
 *
 * Imports nothing from `react-native`, so it runs and is tested under Node.
 */
import { isRetryable } from "@gusnips/http/retry";
import { ApiError, type ApiClient, type SessionAdapter } from "@gusnips/react";
import type { OpenStream, SendCommand } from "@providerkit/native";
import { TransportError, type DisplayError } from "@providerkit/react";
import { openSseStream } from "./sse.ts";

export interface ProviderkitTransportAdapterOptions {
  /** Base URL passed to `createApiClient`, with no trailing slash. Used to turn a relative
   * `observe` path into the full URL `openSseStream` needs, and to strip the prefix when a command
   * builder returns a full URL on that same origin. */
  baseUrl: string;
  /** The app's `ApiClient`, used for `send`, `respond` and `stop`. */
  client: Pick<ApiClient, "request">;
  /** The same `SessionAdapter` `client` was built with, so a 401 on `observe` shares its
   * single-flight refresh. Leave out for unauthenticated streams. */
  session?: SessionAdapter;
  /** Extra headers computed per stream open, like `createApiClient`'s `headers`. Request headers
   * set by the builder win on a name collision. */
  headers?: () => Record<string, string>;
}

export interface ProviderkitTransportAdapter {
  /** Pass directly to `createSseTransport({ ...builders, ...adapter })`. */
  open: OpenStream;
  /** Pass directly to `createSseTransport({ ...builders, ...adapter })`. */
  command: SendCommand;
}

const HTTP_URL = /^https?:\/\//i;

function leadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function streamUrl(base: string, url: string): string {
  if (HTTP_URL.test(url)) return url;
  return `${base}${leadingSlash(url)}`;
}

function clientPath(base: string, url: string): string {
  if (!HTTP_URL.test(url)) return leadingSlash(url);
  if (url === base) return "";
  if (url.startsWith(`${base}/`) || url.startsWith(`${base}?`) || url.startsWith(`${base}#`))
    return url.slice(base.length);
  throw new RangeError(
    `Command URL "${url}" does not start with baseUrl "${base}". Return a path relative to baseUrl or a URL under it.`,
  );
}

/**
 * Turns a kit `ApiError` into `@providerkit/react`'s `TransportError`.
 *
 * A 4xx means the server refused and did nothing (`refused`), with transient refusals that
 * `@gusnips/http/retry` considers retryable (such as a short-wait 408, 425 or 429) marked
 * `retryable` so a stream can retry after waiting. A 5xx means the outcome is unknown (`unknown`).
 * The server's own `code` is kept when present; otherwise `http_<status>` matches
 * `@providerkit/react/sse`.
 */
export function toTransportError(error: ApiError): TransportError {
  const { status } = error;
  const isRefusal = status >= 400 && status < 500;
  const fallback = isRefusal
    ? `The server turned down the request (error ${status}).`
    : `The server had a problem (error ${status}).`;
  const display: DisplayError = {
    code: error.code ?? `http_${status}`,
    message: error.hasMessage ? error.message : fallback,
  };
  if (isRefusal && isRetryable(error, { repeatable: false })) display.retryable = true;
  return new TransportError(isRefusal ? "refused" : "unknown", display, { cause: error });
}

const NETWORK_ERROR: DisplayError = Object.freeze({
  code: "network",
  message: "Could not reach the server. Check your connection and try again.",
});

function normalizeError(error: unknown): TransportError {
  if (error instanceof TransportError) return error;
  if (error instanceof ApiError) return toTransportError(error);
  return new TransportError("unknown", NETWORK_ERROR, { cause: error });
}

function streamHeaders(
  extra: Record<string, string> | undefined,
  request: Record<string, string>,
  method: "GET" | "POST",
): Record<string, string> {
  // openSseStream sets Accept (and Content-Type for POST), so drop those headers to prevent
  // XMLHttpRequest from concatenating duplicate values, and fold case-insensitive collisions so
  // per-request headers win over extra headers.
  const byLower = new Map<string, [string, string]>();
  for (const source of [extra, request]) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      const lower = name.toLowerCase();
      if (lower === "accept" || (method === "POST" && lower === "content-type")) continue;
      byLower.set(lower, [name, value]);
    }
  }
  return Object.fromEntries(byLower.values());
}

/**
 * Builds the `open` and `command` functions for `@providerkit/native`'s `createSseTransport`:
 *
 * ```ts
 * import { createSseTransport } from "@providerkit/native";
 * import { createProviderkitAdapter } from "@gusnips/native/providerkit";
 *
 * const adapter = createProviderkitAdapter({ baseUrl: API_URL, client: api, session });
 * const transport = createSseTransport({
 *   observe: (cursor) => (cursor ? `/chat/events?after=${cursor.seq}` : "/chat/events"),
 *   send: () => "/chat/send",
 *   respond: () => "/chat/respond",
 *   stop: () => "/chat/stop",
 *   ...adapter,
 * });
 * ```
 */
export function createProviderkitAdapter(
  options: ProviderkitTransportAdapterOptions,
): ProviderkitTransportAdapter {
  const base = options.baseUrl.replace(/\/+$/, "");
  const { client, session, headers: extraHeaders } = options;

  const open: OpenStream = (request, handlers) => {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "POST")
      throw new RangeError(
        `openSseStream only supports GET and POST, received "${request.method}". Use GET or POST for observe.`,
      );
    return openSseStream({
      url: streamUrl(base, request.url),
      method,
      body: request.body,
      session,
      headers: () => streamHeaders(extraHeaders?.(), request.headers, method),
      onFrame: (frame) => handlers.onData(frame.data),
      onError: (error) => handlers.onError(normalizeError(error)),
      onClose: () => handlers.onClose(),
    });
  };

  const command: SendCommand = async (request, { signal }) => {
    const path = clientPath(base, request.url);
    try {
      const response = await client.request(path, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined && { body: JSON.stringify(request.body) }),
        ...(signal && { signal }),
      });
      if (response.status === 204) return undefined;
      if (!response.headers.get("content-type")?.toLowerCase().includes("json")) return undefined;
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw normalizeError(error);
    }
  };

  return { open, command };
}
