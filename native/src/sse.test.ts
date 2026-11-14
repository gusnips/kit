import { ApiError, type SessionAdapter, type SseFrame } from "@gusnips/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSseStream, type SseStreamOptions } from "./sse.ts";

/** Just the part of XMLHttpRequest the stream touches, driven by hand. */
class FakeXhr {
  static opened: FakeXhr[] = [];
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
  open() {
    FakeXhr.opened.push(this);
  }
  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
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
  /** The server wrote more: `responseText` grows, as it does on React Native. */
  arrive(text: string) {
    this.responseText += text;
    this.onprogress?.();
  }
}

const settle = () => new Promise((done) => setTimeout(done, 0));

/** A session whose refresh hands out `fresh` once, the way the API client's adapter does. */
function sessionWith(fresh: string | null): SessionAdapter & { refresh: ReturnType<typeof vi.fn> } {
  return {
    getToken: async () => "old",
    refresh: vi.fn(async () => ({ token: fresh, reachedAuth: true })),
    signOut: async () => {},
  };
}

function open(overrides: Partial<SseStreamOptions> = {}) {
  const frames: SseFrame[] = [];
  const onError = vi.fn<(error: Error) => void>();
  const onClose = vi.fn();
  const stream = openSseStream({
    url: "https://api.test/stream",
    body: { message: "hi" },
    session: sessionWith("new"),
    headers: () => ({ "Accept-Language": "pt-BR" }),
    onFrame: (frame) => frames.push(frame),
    onError,
    onClose,
    ...overrides,
  });
  return { stream, frames, onError, onClose };
}

beforeEach(() => {
  FakeXhr.opened = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

describe("openSseStream", () => {
  it("feeds each new slice once, and joins a frame split across progress events", async () => {
    const { frames, onClose } = open();
    await settle();
    const xhr = FakeXhr.opened[0]!;
    expect(xhr.requestHeaders).toMatchObject({
      Authorization: "Bearer old",
      Accept: "text/event-stream",
      "Accept-Language": "pt-BR",
    });
    expect(xhr.sent).toBe('{"message":"hi"}');

    xhr.arrive('event: delta\ndata: {"text":"Hel');
    expect(frames).toEqual([]);
    xhr.arrive('lo"}\n\nevent: delta\ndata: {"text":" there"}\n\n');
    xhr.arrive(""); // a progress event with nothing new delivers nothing twice
    expect(frames.map((frame) => frame.data)).toEqual(['{"text":"Hello"}', '{"text":" there"}']);

    // The last frame arrives with the close and without its blank line.
    xhr.responseText += "event: done\ndata: {}";
    xhr.onload?.();
    expect(frames.map((frame) => frame.event)).toEqual(["delta", "delta", "done"]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("sends a GET with no body", async () => {
    open({ method: "GET" });
    await settle();
    expect(FakeXhr.opened[0]!.sent).toBeNull();
    expect(FakeXhr.opened[0]!.requestHeaders["Content-Type"]).toBeUndefined();
  });

  it("throws a refused handshake as the API client's ApiError", async () => {
    const { onError, onClose } = open();
    await settle();
    const xhr = FakeXhr.opened[0]!;
    xhr.status = 402;
    xhr.responseText = '{"error":{"code":"CREDITS_EXHAUSTED","message":"No credits left"}}';
    xhr.responseHeaders = { "x-request-id": "req_1", "retry-after": "30" };
    xhr.onload?.();
    const error = onError.mock.calls[0]![0];
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 402,
      code: "CREDITS_EXHAUSTED",
      requestId: "req_1",
      retryAfterSecs: 30,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reads a body that is not JSON as a bare status", async () => {
    const { onError } = open();
    await settle();
    const xhr = FakeXhr.opened[0]!;
    xhr.status = 502;
    xhr.responseText = "<html>Bad gateway</html>";
    xhr.onload?.();
    expect(onError.mock.calls[0]![0]).toMatchObject({ status: 502, code: undefined });
  });

  it("refreshes once through the session on a 401 and opens again with the new token", async () => {
    const session = sessionWith("new");
    const { frames, onError } = open({ session });
    await settle();
    FakeXhr.opened[0]!.status = 401;
    FakeXhr.opened[0]!.onload?.();
    await settle();

    const retry = FakeXhr.opened[1]!;
    expect(retry.requestHeaders.Authorization).toBe("Bearer new");
    retry.status = 401;
    retry.onload?.();
    await settle();
    // Once: a second 401 is the answer, not a reason to refresh again.
    expect(session.refresh).toHaveBeenCalledOnce();
    expect(FakeXhr.opened).toHaveLength(2);
    expect(onError.mock.calls[0]![0]).toMatchObject({ status: 401 });
    expect(frames).toEqual([]);
  });

  it("ends with the 401 when there is no session to refresh", async () => {
    const { onError, onClose } = open({ session: sessionWith(null) });
    await settle();
    FakeXhr.opened[0]!.status = 401;
    FakeXhr.opened[0]!.onload?.();
    await settle();
    expect(FakeXhr.opened).toHaveLength(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ status: 401 });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reports a lost connection as a plain Error, not an answer", async () => {
    const { onError } = open();
    await settle();
    FakeXhr.opened[0]!.onerror?.();
    const error = onError.mock.calls[0]![0];
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it("delivers nothing after abort", async () => {
    const { stream, frames, onError, onClose } = open();
    await settle();
    const xhr = FakeXhr.opened[0]!;
    stream.abort();
    expect(xhr.aborted).toBe(true);
    expect(stream.aborted).toBe(true);
    xhr.arrive("data: late\n\n");
    xhr.onerror?.();
    xhr.onload?.();
    expect(frames).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("never opens when aborted before the headers are ready", async () => {
    const { stream } = open();
    stream.abort();
    await settle();
    expect(FakeXhr.opened).toHaveLength(0);
  });
});
