/**
 * Server-sent events on React Native, over `XMLHttpRequest`.
 *
 * React Native's `fetch` never gives a response body you can read as it arrives: there is no
 * `ReadableStream` on it, so `readSseStream` from `@gusnips/react` has nothing to read. XHR does
 * fire `onprogress` with a `responseText` that grows as bytes land, and that is the channel every
 * RN app streaming from a server ends up on. The framing is `@gusnips/react`'s `createSseParser`,
 * the same state machine the web reads with. Only the feed is different: here it is handed the new
 * slice of `responseText` on each progress event.
 *
 * A second transport has a cost the kit already paid for once: it drifts from the API client. So
 * this one keeps to the client's contract where it can. A refused handshake throws the client's own
 * `ApiError`, read from the same envelope and the same `Retry-After` header, so a 402 on a stream
 * gets the sentence and the button any other 402 in the app gets. The token and the 401 refresh come
 * from the same `SessionAdapter` the client is built on. Single flight is the adapter's job and this
 * adds none of its own, so a stream opening mid-load joins the refresh every other request is
 * waiting on instead of racing it. GoTrue rotates the refresh token on use, and the loser of that race would sign the
 * person out. The donor kept a hand-rolled single flight beside its client for this; it existed only
 * because the adapter did not have one.
 *
 * No reconnect. The donor's chat store had its own recovery (it refetches the transcript when a
 * stream breaks), and a loop here would have been a second one nobody asked for.
 */
import { isApiError } from "@gusnips/http";
import { parseRetryAfter } from "@gusnips/http/retry";
import { ApiError, createSseParser, type SessionAdapter, type SseFrame } from "@gusnips/react";

export interface SseStreamOptions {
  /** The whole address of the stream, `https://api.example.com/chat/stream`. */
  url: string;
  /** POST, the default, sends `body` as JSON. GET sends nothing. */
  method?: "GET" | "POST";
  body?: unknown;
  /**
   * The adapter your `createApiClient` uses. Its token goes out as `Authorization: Bearer`, and a
   * 401 calls its `refresh()` once and opens again with the new token. Leave it out for a stream
   * that needs no sign-in.
   */
  session?: SessionAdapter;
  /** Extra headers, computed when the request opens, like the API client's `headers`. */
  headers?: () => Record<string, string>;
  /**
   * Called once response headers arrive for a 2xx response, before any body bytes are fed to the
   * frame parser. Throw to refuse the response (for example when `content-type` is not
   * `text/event-stream`): the XHR aborts and `onError` receives what was thrown.
   */
  onResponse?: (response: { status: number; contentType: string | null }) => void;
  /** One frame off the wire. `data` is raw text: parse it the way your server writes it. */
  onFrame: (frame: SseFrame) => void;
  /**
   * The stream failed. An `ApiError` when the server answered with a refusal, so the describer
   * explains it like any other; a plain `Error` when nothing came back at all.
   */
  onError?: (error: Error) => void;
  /** The stream ended, cleanly or not, without `abort()` being called. */
  onClose?: () => void;
}

export interface SseStream {
  readonly aborted: boolean;
  /** Close the socket. No frame, error or close is delivered after this. */
  abort(): void;
}

/** The request id header `createApiClient` reads by default. */
const REQUEST_ID_HEADER = "x-request-id";

/**
 * Open a stream. It starts at once; keep the handle to stop it.
 *
 * ```ts
 * const stream = openSseStream({
 *   url: `${API_URL}/chat/stream`,
 *   body: { message },
 *   session, // the same adapter createApiClient uses
 *   onFrame: ({ event, data }) => handle(event, JSON.parse(data)),
 * });
 * ```
 *
 * ponytail: XHR keeps the whole response in `responseText`, so memory grows with the length of the
 * stream. A chat turn is fine. A feed left open all day is not; that needs a native streaming module.
 */
export function openSseStream(options: SseStreamOptions): SseStream {
  const {
    url,
    method = "POST",
    body,
    session,
    headers,
    onResponse,
    onFrame,
    onError,
    onClose,
  } = options;
  let aborted = false;
  let refreshed = false;
  let current: XMLHttpRequest | null = null;

  const fail = (error: Error) => {
    if (aborted) return;
    onError?.(error);
    onClose?.();
  };
  const asError = (thrown: unknown, fallback: string) =>
    thrown instanceof Error ? thrown : new Error(fallback);

  function start(token: string | null): void {
    if (aborted) return;
    const xhr = new XMLHttpRequest();
    current = xhr;
    let read = 0;
    let responseState: "pending" | "ok" | "refused" = "pending";
    const parser = createSseParser((frame) => {
      if (!aborted) onFrame(frame);
    });

    xhr.open(method, url);
    if (method !== "GET") xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "text/event-stream");
    for (const [name, value] of Object.entries(headers?.() ?? {}))
      xhr.setRequestHeader(name, value);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    // Run `onResponse` once on the first 2xx callback (progress or load), before feeding any bytes
    // into the SSE parser. A throw refuses the stream immediately and aborts the socket.
    const checkResponse = (): boolean => {
      if (responseState !== "pending") return responseState === "ok";
      if (xhr.status < 200 || xhr.status >= 300) return true;
      responseState = "ok";
      if (!onResponse) return true;
      try {
        onResponse({
          status: xhr.status,
          contentType: xhr.getResponseHeader("content-type"),
        });
        return !aborted;
      } catch (thrown) {
        responseState = "refused";
        xhr.abort();
        fail(asError(thrown, "The stream response was refused"));
        return false;
      }
    };

    // `responseText` is everything so far, not the new part. Feed only what was not fed yet, or
    // every frame is delivered again on every progress event.
    const drain = () => {
      if (aborted || !checkResponse() || xhr.responseText.length <= read) return;
      const next = xhr.responseText.slice(read);
      read = xhr.responseText.length;
      parser.feed(next);
    };
    xhr.onprogress = drain;

    xhr.onload = () => {
      if (aborted || responseState === "refused") return;
      if (xhr.status === 401 && session && !refreshed) {
        refreshed = true;
        const refused = refusalOf(xhr);
        // No token back means no session to retry with, whether auth refused or never answered.
        // The stream ends with the 401; signing out stays the API client's call, so a dead session
        // has one place that ends it.
        session.refresh().then(
          ({ token: fresh }) => (fresh ? start(fresh) : fail(refused)),
          (thrown: unknown) => fail(asError(thrown, "Could not refresh the session")),
        );
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        fail(refusalOf(xhr));
        return;
      }
      if (!checkResponse()) return;
      // A last frame the server closed without its blank line. Two newlines close it whether the
      // stream ended mid-frame or after one newline; after a complete frame they add nothing.
      drain();
      parser.feed("\n\n");
      onClose?.();
    };
    xhr.onerror = () => {
      if (responseState !== "refused") fail(new Error("The stream lost its connection"));
    };
    xhr.ontimeout = () => {
      if (responseState !== "refused") fail(new Error("The stream timed out"));
    };

    xhr.send(method === "GET" ? null : JSON.stringify(body ?? {}));
  }

  (session ? session.getToken() : Promise.resolve(null)).then(start, (thrown: unknown) =>
    fail(asError(thrown, "Could not read the session")),
  );

  return {
    get aborted() {
      return aborted;
    },
    abort() {
      aborted = true;
      current?.abort();
    },
  };
}

/** The refusal as the API client would have thrown it: the envelope, the request id, the wait. */
function refusalOf(xhr: XMLHttpRequest): ApiError {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(xhr.responseText);
  } catch {
    // Not JSON, such as a gateway's HTML page. The status is all there is.
  }
  return new ApiError(xhr.status, isApiError(parsed) ? parsed.error : null, {
    requestId: xhr.getResponseHeader(REQUEST_ID_HEADER) ?? undefined,
    retryAfterSecs: parseRetryAfter(xhr.getResponseHeader("retry-after")),
  });
}
