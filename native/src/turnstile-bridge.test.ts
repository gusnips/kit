import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowsNavigation,
  createTurnstileBridge,
  normalizeOrigin,
  originOf,
  parseTurnstileMessage,
  type NativeTurnstileOptions,
  type TurnstileBridge,
  type TurnstileView,
} from "./turnstile-bridge.ts";
import { MESSAGE_VERSION, turnstilePage } from "./turnstile-page.ts";

const ORIGIN = "https://app.example.com";
const CLOUDFLARE = "https://challenges.cloudflare.com";
const bridges = new Set<TurnstileBridge>();

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const bridge of bridges) bridge.detach();
  bridges.clear();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

const nonceOf = (view: TurnstileView) =>
  /"nonce":"([^"]+)"/.exec(view.props.source.html)?.[1] ?? "";

/** A phone whose WebView is this test: it reads the props the check hands out and calls them. */
function phone(options: Partial<NativeTurnstileOptions> = {}) {
  const bridge = createTurnstileBridge({
    siteKey: "public-key",
    action: "signin",
    origin: ORIGIN,
    // Most tests want the WebView up at once. The default is covered on its own below.
    eager: true,
    ...options,
  });
  bridges.add(bridge);
  const view = () => {
    const mounted = bridge.getSnapshot().view;
    if (!mounted) throw new Error("No WebView is mounted");
    return mounted;
  };
  const tell = (
    to: TurnstileView,
    type: string,
    extra: Record<string, unknown> = {},
    url = `${ORIGIN}/`,
  ) =>
    to.props.onMessage({
      nativeEvent: {
        data: JSON.stringify({ v: MESSAGE_VERSION, nonce: nonceOf(to), type, ...extra }),
        url,
      },
    });
  return {
    bridge,
    view,
    state: () => bridge.getSnapshot().state,
    say: (type: string, extra?: Record<string, unknown>, url?: string) =>
      tell(view(), type, extra, url),
    tell,
  };
}

describe("the check", () => {
  it("is off without a site key: no WebView, no fake token", async () => {
    const check = phone({ siteKey: undefined, origin: undefined });
    check.bridge.attach();
    expect(check.state()).toBe("off");
    expect(check.bridge.getSnapshot().view).toBeNull();
    await expect(check.bridge.take()).resolves.toBeUndefined();
  });

  it("loads its page as the registered origin, out of sight", () => {
    const check = phone({ origin: "HTTPS://App.Example.com/", language: "PT-br" });
    check.bridge.attach();
    const { props, shown } = check.view();
    expect(check.state()).toBe("loading");
    expect(shown).toBe(false);
    expect(props.source.baseUrl).toBe(`${ORIGIN}/`);
    expect(props.source.html).toContain('"siteKey":"public-key"');
    expect(props.source.html).toContain('"action":"signin"');
    expect(props.source.html).toContain('"language":"pt-br"');
    expect(props.source.html).toContain(`frame-src ${CLOUDFLARE}`);
  });

  it("refuses an origin Cloudflare would not check a widget against", () => {
    for (const origin of [
      undefined,
      "",
      "http://app.example.com",
      "https://app.example.com/login",
      "https://user@app.example.com",
      "https://app.example.com:99999x",
      "app.example.com",
    ]) {
      expect(() => phone({ origin }), String(origin)).toThrow(/https address/);
    }
    expect(normalizeOrigin("https://localhost:8443")).toBe("https://localhost:8443");
  });

  it("waits for the first take() by default, so nothing contacts Cloudflare before a press", async () => {
    const check = phone({ eager: undefined });
    check.bridge.attach();
    expect(check.state()).toBe("idle");
    expect(check.bridge.getSnapshot().view).toBeNull();
    const token = check.bridge.take();
    expect(check.state()).toBe("loading");
    check.say("token", { token: "first" });
    await expect(token).resolves.toBe("first");
  });

  it("mounts the WebView on attach when eager is true", () => {
    const check = phone({ eager: true });
    check.bridge.attach();
    expect(check.state()).toBe("loading");
    expect(check.view().props.source.baseUrl).toBe(`${ORIGIN}/`);
  });

  it("draws the round's code from crypto when it exists, and still has one when it does not", () => {
    const withCrypto = phone();
    withCrypto.bridge.attach();
    expect(nonceOf(withCrypto.view())).toMatch(/^[0-9a-f]{32}$/);

    vi.stubGlobal("crypto", undefined);
    try {
      const without = phone();
      without.bridge.attach();
      const first = nonceOf(without.view());
      expect(first.length).toBeGreaterThanOrEqual(8);
      without.say("expired");
      expect(nonceOf(without.view())).not.toBe(first);
      without.say("token", { token: "still works" });
      expect(without.state()).toBe("ready");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives a token to one caller and mounts a fresh WebView for the next", async () => {
    const check = phone();
    check.bridge.attach();
    const first = check.view();
    const waiting = check.bridge.take();
    await expect(check.bridge.take()).rejects.toMatchObject({ reason: "busy" });
    check.tell(first, "token", { token: "once" });
    await expect(waiting).resolves.toBe("once");
    const second = check.view();
    expect(second.key).not.toBe(first.key);
    expect(check.state()).toBe("loading");
    // The old page answering late is a page nobody is waiting on. A positive control follows.
    check.tell(first, "token", { token: "late" });
    expect(check.state()).toBe("loading");
    const next = check.bridge.take();
    check.tell(second, "token", { token: "current" });
    await expect(next).resolves.toBe("current");
  });

  it("holds a ready token for exactly one take, even for two calls in one tick", async () => {
    const check = phone();
    check.bridge.attach();
    check.say("token", { token: "ready" });
    expect(check.state()).toBe("ready");
    const first = check.bridge.take();
    const second = check.bridge.take();
    await expect(first).resolves.toBe("ready");
    check.say("token", { token: "next" });
    await expect(second).resolves.toBe("next");
  });

  it("shows the WebView only while Cloudflare needs the person", () => {
    const check = phone();
    check.bridge.attach();
    check.say("interactive");
    expect(check.state()).toBe("interactive");
    expect(check.view().shown).toBe(true);
    check.say("afterInteractive");
    expect(check.state()).toBe("loading");
    expect(check.view().shown).toBe(false);
  });

  it("fails a waiting take when the script cannot load, and retry mounts a new WebView", async () => {
    const check = phone();
    check.bridge.attach();
    const first = check.view();
    const waiting = check.bridge.take();
    check.say("unavailable");
    await expect(waiting).rejects.toMatchObject({ reason: "unavailable" });
    expect(check.state()).toBe("unavailable");
    expect(check.bridge.getSnapshot().view).toBeNull();
    check.bridge.retry();
    expect(check.state()).toBe("loading");
    expect(check.view().key).not.toBe(first.key);
  });

  it("does not retry a phone that cannot run the check", async () => {
    const check = phone();
    check.bridge.attach();
    check.say("unsupported");
    expect(check.state()).toBe("unsupported");
    check.bridge.retry();
    expect(check.state()).toBe("unsupported");
    await expect(check.bridge.take()).rejects.toMatchObject({ reason: "unsupported" });
  });

  it("starts a new round when Cloudflare says the token expired", () => {
    const check = phone();
    check.bridge.attach();
    const before = check.view();
    check.say("token", { token: "old" });
    check.say("expired");
    expect(check.state()).toBe("loading");
    expect(check.view().key).not.toBe(before.key);
  });

  it("gives up on a page that never answers, but not on one that did", () => {
    const silent = phone();
    silent.bridge.attach();
    vi.advanceTimersByTime(29_999);
    expect(silent.state()).toBe("loading");
    vi.advanceTimersByTime(1);
    expect(silent.state()).toBe("unavailable");

    const answered = phone();
    answered.bridge.attach();
    answered.say("rendered");
    vi.advanceTimersByTime(120_000);
    expect(answered.state()).toBe("loading");
  });

  it("cancels a waiting take when the screen closes, and survives a StrictMode remount", async () => {
    const check = phone();
    check.bridge.attach();
    const waiting = check.bridge.take();
    check.bridge.detach();
    await expect(waiting).rejects.toMatchObject({ reason: "cancelled" });
    expect(check.state()).toBe("idle");
    expect(check.bridge.getSnapshot().view).toBeNull();
    check.bridge.attach();
    expect(check.state()).toBe("loading");
    check.say("token", { token: "again" });
    await expect(check.bridge.take()).resolves.toBe("again");
  });

  it("calls an empty or oversized token a failed check, never a token", async () => {
    for (const token of ["", "x".repeat(2049)]) {
      const check = phone();
      check.bridge.attach();
      const waiting = check.bridge.take();
      check.say("token", { token });
      await expect(waiting).rejects.toMatchObject({ reason: "failed" });
      expect(check.state()).toBe("failed");
    }
  });
});

describe("what the page may say", () => {
  const message = (extra: Record<string, unknown>) =>
    JSON.stringify({ v: MESSAGE_VERSION, nonce: "n1", type: "token", token: "t", ...extra });

  it("takes only a message that carries this round's code", () => {
    expect(parseTurnstileMessage(message({}), "n1")).toEqual({ type: "token", token: "t" });
    expect(parseTurnstileMessage(message({}), "n2")).toBeNull();
    expect(parseTurnstileMessage(message({ nonce: undefined }), "n1")).toBeNull();
    expect(parseTurnstileMessage(message({ v: 2 }), "n1")).toBeNull();
  });

  it("drops what is not a message of ours", () => {
    expect(parseTurnstileMessage("not json", "n1")).toBeNull();
    expect(parseTurnstileMessage("[]", "n1")).toBeNull();
    expect(parseTurnstileMessage("null", "n1")).toBeNull();
    expect(parseTurnstileMessage(undefined, "n1")).toBeNull();
    expect(parseTurnstileMessage(message({ type: "navigate" }), "n1")).toBeNull();
    expect(parseTurnstileMessage(message({ type: "__proto__" }), "n1")).toBeNull();
    expect(parseTurnstileMessage("x".repeat(5000), "n1")).toBeNull();
  });

  it("ignores a message from a page that is not ours, with the same message from ours as control", () => {
    const foreign = [
      "https://evil.example/",
      `${CLOUDFLARE}/cdn-cgi/challenge`,
      "https://app.example.com.evil.test/",
      "https://app.example.com@evil.test/",
      "http://app.example.com/",
      "file:///private/page.html",
    ];
    for (const url of foreign) {
      const stranger = phone();
      stranger.bridge.attach();
      stranger.say("token", { token: "stolen" }, url);
      expect(stranger.state(), url).toBe("loading");
    }
    for (const url of [`${ORIGIN}/`, ORIGIN, "about:blank", ""]) {
      const ours = phone();
      ours.bridge.attach();
      ours.say("token", { token: "own" }, url);
      expect(ours.state(), url).toBe("ready");
    }
  });
});

describe("the lock on the WebView", () => {
  it("loads only its own page and the Cloudflare frame inside it", () => {
    const top = (url: string) => allowsNavigation({ url, isTopFrame: true }, ORIGIN);
    const frame = (url: string) => allowsNavigation({ url, isTopFrame: false }, ORIGIN);
    expect(top(`${ORIGIN}/`)).toBe(true);
    expect(top(ORIGIN)).toBe(true);
    expect(top("about:blank")).toBe(true);
    expect(allowsNavigation({ url: `${ORIGIN}/` }, ORIGIN)).toBe(true);
    expect(frame(`${CLOUDFLARE}/cdn-cgi/challenge-platform/h/b`)).toBe(true);
    expect(frame("about:srcdoc")).toBe(true);

    expect(top(`${ORIGIN}/login`)).toBe(false);
    expect(top(`${CLOUDFLARE}/`)).toBe(false);
    expect(top("https://evil.example/")).toBe(false);
    expect(top("http://app.example.com/")).toBe(false);
    expect(top("file:///private/page.html")).toBe(false);
    expect(top("javascript:alert(1)")).toBe(false);
    expect(top("intent://scan#Intent;scheme=zxing;end")).toBe(false);
    expect(top("data:text/html,hello")).toBe(false);
    expect(top("blob:https://app.example.com/id")).toBe(false);
    expect(frame("https://challenges.cloudflare.com.evil.test/")).toBe(false);
    expect(frame("https://challenges.cloudflare.com@evil.test/")).toBe(false);
    expect(frame(`${ORIGIN}/`)).toBe(false);
  });

  it("puts that lock on the WebView, with no file access and no second window", () => {
    const check = phone();
    check.bridge.attach();
    const { props } = check.view();
    expect(props.onShouldStartLoadWithRequest({ url: "https://evil.example/" })).toBe(false);
    expect(props.onShouldStartLoadWithRequest({ url: `${ORIGIN}/` })).toBe(true);
    // The library opens an address its whitelist rejects in the phone's browser or app. This wide
    // whitelist hands the decision to the function above, which only says no.
    expect(props.originWhitelist).toEqual(["*"]);
    expect(props).toMatchObject({
      javaScriptEnabled: true,
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      mixedContentMode: "never",
      setSupportMultipleWindows: false,
      javaScriptCanOpenWindowsAutomatically: false,
      allowsLinkPreview: false,
    });
  });

  it("reads an origin the way a phone must, without URL.origin", () => {
    expect(originOf("https://App.Example.com:8443/a?b#c")).toBe("https://app.example.com:8443");
    expect(originOf("https://a.test")).toBe("https://a.test");
    expect(originOf("https://good.test@evil.test/")).toBeNull();
    expect(originOf("https://evil.test\\@good.test/")).toBeNull();
    expect(originOf("ftp://a.test/")).toBeNull();
    expect(originOf("about:blank")).toBeNull();
  });

  it("cannot be broken out of by a value that closes the script tag", () => {
    const html = turnstilePage({
      siteKey: '</script><script>alert("x")</script>',
      action: "signin",
      language: "en",
      theme: "auto",
      nonce: "n1",
    });
    expect(html).not.toContain("</script><script>alert");
    const config = /\}\)\((\{.*\})\);\n<\/script>/.exec(html)?.[1];
    expect(JSON.parse(config ?? "{}")).toMatchObject({
      siteKey: '</script><script>alert("x")</script>',
    });
  });
});
