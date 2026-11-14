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
 * gets the sentence and the button any other 402 in the app gets. The 401 refresh is the app's own,
 * handed in as `refreshHeaders`, so a stream starting mid-load refreshes through the client's single
 * flight instead of racing it.
 *
 * No reconnect. The donor's chat store had its own recovery (it refetches the transcript when a
 * stream breaks), and a loop here would have been a second one nobody asked for.
 */
import { isApiError } from "@gusnips/http";
import { parseRetryAfter } from "@gusnips/http/retry";
import { ApiError, createSseParser, type SseFrame } from "@gusnips/react";

export interface SseStreamOptions {
  /** The whole address of the stream, `https://api.example.com/chat/stream`. */
  url: string;
  /** POST, the default, sends `body` as JSON. GET sends nothing. */
  method?: "GET" | "POST";
  body?: unknown;
  /**
   * The headers for the first attempt, usually `Authorization`. Called once, right before the
   * request opens, so a token read here is the current one.
   */
  headers?: () => Promise<Record<string, string>>;
  /**
   * Called once, when the server answers 401: refresh the session and hand back fresh headers to
   * retry with, or `null` when there is no session to refresh. Pass the API client's own refresh,
   * so the stream and every other request share one refresh.
   */
  refreshHeaders?: () => Promise<Record<string, string> | null>;
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
 *   headers: authHeaders,
 *   refreshHeaders: refreshAuthHeaders,
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
    headers,
    refreshHeaders,
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

  function start(sent: Record<string, string>): void {
    if (aborted) return;
    const xhr = new XMLHttpRequest();
    current = xhr;
    let read = 0;
    const parser = createSseParser((frame) => {
      if (!aborted) onFrame(frame);
    });

    xhr.open(method, url);
    if (method !== "GET") xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "text/event-stream");
    for (const [name, value] of Object.entries(sent)) xhr.setRequestHeader(name, value);

    // `responseText` is everything so far, not the new part. Feed only what was not fed yet, or
    // every frame is delivered again on every progress event.
    const drain = () => {
      if (aborted || xhr.responseText.length <= read) return;
      const next = xhr.responseText.slice(read);
      read = xhr.responseText.length;
      parser.feed(next);
    };
    xhr.onprogress = drain;

    xhr.onload = () => {
      if (aborted) return;
      if (xhr.status === 401 && refreshHeaders && !refreshed) {
        refreshed = true;
        const refused = refusalOf(xhr);
        refreshHeaders().then(
          (fresh) => (fresh ? start(fresh) : fail(refused)),
          (thrown: unknown) => fail(asError(thrown, "Could not refresh the session")),
        );
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        fail(refusalOf(xhr));
        return;
      }
      // A last frame the server closed without its blank line. Two newlines close it whether the
      // stream ended mid-frame or after one newline; after a complete frame they add nothing.
      drain();
      parser.feed("\n\n");
      onClose?.();
    };
    xhr.onerror = () => fail(new Error("The stream lost its connection"));
    xhr.ontimeout = () => fail(new Error("The stream timed out"));

    xhr.send(method === "GET" ? null : JSON.stringify(body ?? {}));
  }

  (headers ? headers() : Promise.resolve({})).then(start, (thrown: unknown) =>
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
