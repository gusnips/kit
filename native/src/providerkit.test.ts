import { createApiClient, ApiError, type SessionAdapter } from "@gusnips/react";
import { createSseTransport } from "@providerkit/native";
import { TransportError, type ChatEvent } from "@providerkit/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderkitAdapter, toTransportError } from "./providerkit.ts";

/** Just the part of XMLHttpRequest `openSseStream` touches, driven by hand. */
class FakeXhr {
  static opened: FakeXhr[] = [];
  method = "";
  url = "";
  status = 200;
  responseText = "";
  responseHeaders: Record<string, string> = {};
  requestHeaders: Record<string, string> = {};
  sent: string | null | undefined;
  aborted = false;
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
    FakeXhr.opened.push(this);
  }
  setRequestHeader(name: string, value: string) {
    const existing = this.requestHeaders[name];
    this.requestHeaders[name] = existing ? `${existing}, ${value}` : value;
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name] ?? null;
  }
  send(body: string | null) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
  }
  arrive(text: string) {
    this.responseText += text;
    this.onprogress?.();
  }
}

const settle = () => new Promise((done) => setTimeout(done, 0));

function sessionWith(fresh: string | null): SessionAdapter & {
  getToken: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  refresh: ReturnType<typeof vi.fn<SessionAdapter["refresh"]>>;
} {
  let token: string | null = "old";
  return {
    getToken: vi.fn(async () => token),
    refresh: vi.fn(async () => {
      token = fresh;
      return { token: fresh, reachedAuth: true };
    }),
    signOut: async () => {},
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  FakeXhr.opened = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toTransportError", () => {
  it("maps 4xx ApiError to a refused TransportError and keeps the server code", () => {
    const apiError = new ApiError(402, {
      code: "CREDITS_EXHAUSTED",
      message: "No credits left",
    });
    const error = toTransportError(apiError);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.outcome).toBe("refused");
    expect(error.error).toEqual({ code: "CREDITS_EXHAUSTED", message: "No credits left" });
    expect(error.cause).toBe(apiError);
  });

  it("marks transient 408 and 429 refusals retryable, but not durable 429 refusals", () => {
    const transient = toTransportError(
      new ApiError(429, { code: "RATE_LIMITED", message: "Slow down" }, { retryAfterSecs: 5 }),
    );
    expect(transient.outcome).toBe("refused");
    expect(transient.error.retryable).toBe(true);

    const durable = toTransportError(
      new ApiError(429, {
        code: "QUOTA_EXCEEDED",
        message: "Limit reached",
        details: { retryAfterSecs: null },
      }),
    );
    expect(durable.outcome).toBe("refused");
    expect(durable.error.retryable).toBeUndefined();
  });

  it("maps 5xx ApiError to an unknown TransportError and preserves the server code", () => {
    const apiError = new ApiError(503, {
      code: "UPSTREAM_UNAVAILABLE",
      message: "Try again soon",
    });
    const error = toTransportError(apiError);
    expect(error.outcome).toBe("unknown");
    expect(error.error).toEqual({ code: "UPSTREAM_UNAVAILABLE", message: "Try again soon" });
    expect(error.cause).toBe(apiError);
  });

  it("falls back to http_<status> when the error envelope had no code or message", () => {
    const refused = toTransportError(new ApiError(403, null));
    expect(refused.outcome).toBe("refused");
    expect(refused.error).toEqual({
      code: "http_403",
      message: "The server turned down the request (error 403).",
    });

    const server = toTransportError(new ApiError(502, null));
    expect(server.outcome).toBe("unknown");
    expect(server.error).toEqual({
      code: "http_502",
      message: "The server had a problem (error 502).",
    });
  });
});

describe("createProviderkitAdapter", () => {
  it("forwards SSE frames and aborts the XHR when the AbortSignal fires through createSseTransport", async () => {
    const session = sessionWith("new");
    const client = createApiClient({
      baseUrl: "https://api.test/v1",
      session,
      onSessionDead: vi.fn(),
    });
    const adapter = createProviderkitAdapter({
      baseUrl: "https://api.test/v1/",
      client,
      session,
      headers: () => ({ "Accept-Language": "en", "X-Custom": "from-extra" }),
    });
    const transport = createSseTransport({
      observe: (cursor) => ({
        url: cursor ? `/chat/events?after=${cursor.seq}` : "/chat/events",
        headers: { "X-Custom": "from-request" },
      }),
      ...adapter,
    });

    const controller = new AbortController();
    const received: ChatEvent[] = [];
    const reading = (async () => {
      for await (const event of transport.observe!({
        cursor: { seq: 4 },
        signal: controller.signal,
      })) {
        received.push(event);
        if (received.length === 1) controller.abort();
      }
    })();

    await settle();
    const xhr = FakeXhr.opened[0]!;
    expect(xhr.method).toBe("GET");
    expect(xhr.url).toBe("https://api.test/v1/chat/events?after=4");
    expect(xhr.requestHeaders).toEqual({
      Accept: "text/event-stream",
      "Accept-Language": "en",
      "x-custom": "from-request",
      Authorization: "Bearer old",
    });

    xhr.arrive('data: {"v":1,"type":"run","seq":5,"run":{"status":"running"}}\n\n');
    await reading;

    expect(received).toEqual([{ v: 1, type: "run", seq: 5, run: { status: "running" } }]);
    expect(xhr.aborted).toBe(true);
  });

  it("passes a 401 refresh through the shared session on observe and delivers frames after retry", async () => {
    const session = sessionWith("fresh-token");
    const client = createApiClient({
      baseUrl: "https://api.test/v1",
      session,
      onSessionDead: vi.fn(),
    });
    const adapter = createProviderkitAdapter({
      baseUrl: "https://api.test/v1",
      client,
      session,
    });

    const frames: string[] = [];
    const onError = vi.fn();
    const onClose = vi.fn();
    adapter.open(
      { url: "/chat/events", method: "GET", headers: { accept: "text/event-stream" } },
      { onData: (data) => frames.push(data), onError, onClose },
    );

    await settle();
    FakeXhr.opened[0]!.status = 401;
    FakeXhr.opened[0]!.onload?.();
    await settle();

    expect(session.refresh).toHaveBeenCalledOnce();
    const retried = FakeXhr.opened[1]!;
    expect(retried.requestHeaders.Authorization).toBe("Bearer fresh-token");
    retried.arrive('data: {"v":1,"type":"run","seq":1,"run":{"status":"completed"}}\n\n');
    retried.onload?.();

    expect(frames).toEqual(['{"v":1,"type":"run","seq":1,"run":{"status":"completed"}}']);
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("converts stream 4xx, 5xx and network failures into TransportError", async () => {
    const session = sessionWith(null);
    const client = createApiClient({
      baseUrl: "https://api.test/v1",
      session,
      onSessionDead: vi.fn(),
    });
    const adapter = createProviderkitAdapter({
      baseUrl: "https://api.test/v1",
      client,
      session,
    });

    const errors: unknown[] = [];
    const openOnce = () =>
      adapter.open(
        { url: "/chat/events", method: "GET", headers: { accept: "text/event-stream" } },
        { onData: () => {}, onError: (error) => errors.push(error), onClose: () => {} },
      );

    openOnce();
    await settle();
    const refusedXhr = FakeXhr.opened[0]!;
    refusedXhr.status = 403;
    refusedXhr.responseText = '{"error":{"code":"FORBIDDEN","message":"No access"}}';
    refusedXhr.onload?.();

    openOnce();
    await settle();
    const serverXhr = FakeXhr.opened[1]!;
    serverXhr.status = 500;
    serverXhr.responseText = '{"error":{"code":"INTERNAL_ERROR","message":"Boom"}}';
    serverXhr.onload?.();

    openOnce();
    await settle();
    FakeXhr.opened[2]!.onerror?.();

    expect(errors[0]).toBeInstanceOf(TransportError);
    expect(errors[0]).toMatchObject({
      outcome: "refused",
      error: { code: "FORBIDDEN", message: "No access" },
    });
    expect(errors[1]).toBeInstanceOf(TransportError);
    expect(errors[1]).toMatchObject({
      outcome: "unknown",
      error: { code: "INTERNAL_ERROR", message: "Boom" },
    });
    expect(errors[2]).toBeInstanceOf(TransportError);
    expect(errors[2]).toMatchObject({
      outcome: "unknown",
      error: { code: "network" },
    });
  });

  it("sends commands through ApiClient with 401 refresh passthrough and AbortSignal", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "UNAUTHORIZED", message: "Expired" } }, 401),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { received: true } }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const session = sessionWith("refreshed");
    const client = createApiClient({
      baseUrl: "https://api.test/v1",
      session,
      onSessionDead: vi.fn(),
    });
    const adapter = createProviderkitAdapter({
      baseUrl: "https://api.test/v1",
      client,
      session,
    });
    const transport = createSseTransport({
      send: () => "https://api.test/v1/chat/send",
      ...adapter,
    });

    const controller = new AbortController();
    await transport.send!({ clientId: "c1", text: "Hello" }, { signal: controller.signal });

    expect(session.refresh).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/v1/chat/send");
    const secondInit = fetchMock.mock.calls[1]![1]!;
    expect(new Headers(secondInit.headers).get("authorization")).toBe("Bearer refreshed");
    expect(secondInit.body).toBe(JSON.stringify({ clientId: "c1", text: "Hello" }));
  });

  it("converts command 4xx refused, 5xx unknown and network errors into TransportError", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "VALIDATION_ERROR", message: "Empty text" } }, 400),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "SERVICE_UNAVAILABLE", message: "Down" } }, 503),
      )
      .mockRejectedValueOnce(new TypeError("Network request failed"));
    vi.stubGlobal("fetch", fetchMock);

    const session = sessionWith("new");
    const client = createApiClient({
      baseUrl: "https://api.test/v1",
      session,
      onSessionDead: vi.fn(),
    });
    const adapter = createProviderkitAdapter({
      baseUrl: "https://api.test/v1",
      client,
      session,
    });

    const req = {
      url: "/chat/send",
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { clientId: "c1", text: "" },
    };

    const refused = await adapter.command(req, {}).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TransportError);
    expect(refused).toMatchObject({
      outcome: "refused",
      error: { code: "VALIDATION_ERROR", message: "Empty text" },
    });

    const unknown = await adapter.command(req, {}).catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(TransportError);
    expect(unknown).toMatchObject({
      outcome: "unknown",
      error: { code: "SERVICE_UNAVAILABLE", message: "Down" },
    });

    const network = await adapter.command(req, {}).catch((error: unknown) => error);
    expect(network).toBeInstanceOf(TransportError);
    expect(network).toMatchObject({
      outcome: "unknown",
      error: { code: "network" },
    });
  });

  it("rethrows caller abort on command without wrapping it in TransportError", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");
    const fetchMock = vi.fn<typeof fetch>(async () => {
      controller.abort();
      throw abortError;
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = sessionWith("new");
    const client = createApiClient({
      baseUrl: "https://api.test/v1",
      session,
      onSessionDead: vi.fn(),
    });
    const adapter = createProviderkitAdapter({
      baseUrl: "https://api.test/v1",
      client,
      session,
    });

    const thrown = await adapter
      .command(
        { url: "/chat/send", method: "POST", headers: {}, body: { clientId: "c1", text: "hi" } },
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);

    expect(thrown).not.toBeInstanceOf(TransportError);
    expect(thrown).toBe(abortError);
  });

  it("rejects command URLs outside baseUrl and unsupported stream methods", async () => {
    const session = sessionWith("new");
    const client = createApiClient({
      baseUrl: "https://api.test/v1",
      session,
      onSessionDead: vi.fn(),
    });
    const adapter = createProviderkitAdapter({
      baseUrl: "https://api.test/v1",
      client,
      session,
    });

    await expect(
      adapter.command({ url: "https://other.test/chat/send", method: "POST", headers: {} }, {}),
    ).rejects.toThrow(RangeError);

    expect(() =>
      adapter.open(
        { url: "/chat/events", method: "PUT", headers: {} },
        { onData: () => {}, onError: () => {}, onClose: () => {} },
      ),
    ).toThrow(RangeError);
  });
});
