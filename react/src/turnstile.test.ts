// @vitest-environment happy-dom
import { act, createElement, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnstileOptions, useTurnstile } from "./turnstile.ts";

type Api = NonNullable<Window["turnstile"]>;
type WidgetOptions = Parameters<Api["render"]>[1];
const roots = new Set<Root>();

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  delete window.turnstile;
});
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window.turnstile;
});

function provider(onRender?: (options: WidgetOptions) => void) {
  const widgets: WidgetOptions[] = [];
  const api: Api = {
    render: vi.fn((_element, options) => {
      widgets.push(options);
      onRender?.(options);
      return String(widgets.length);
    }),
    remove: vi.fn(),
  };
  window.turnstile = api;
  return { api, widgets };
}

function interceptScripts() {
  const scripts: HTMLScriptElement[] = [];
  vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
    for (const node of nodes) if (node instanceof HTMLScriptElement) scripts.push(node);
  });
  return scripts;
}

async function mount(options: Partial<TurnstileOptions> = {}, strict = false) {
  const { useTurnstile: useCheck } = await import("./turnstile.ts");
  let config: TurnstileOptions = { siteKey: "public-key", action: "contact", ...options };
  let current: ReturnType<typeof useTurnstile> | undefined;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.add(root);
  function Form() {
    const check = useCheck(config);
    useLayoutEffect(() => {
      current = check;
    }, [check]);
    return createElement("div", { ref: check.container });
  }
  const render = () =>
    root.render(
      strict ? createElement(StrictMode, null, createElement(Form)) : createElement(Form),
    );
  await act(async () => render());
  return {
    get check() {
      if (!current) throw new Error("Check did not mount");
      return current;
    },
    take() {
      let result: Promise<string | undefined> | undefined;
      act(() => {
        result = this.check.take();
      });
      if (!result) throw new Error("Take did not return a promise");
      return result;
    },
    async change(next: Partial<TurnstileOptions>) {
      config = { ...config, ...next };
      await act(async () => render());
    },
    unmount() {
      act(() => root.unmount());
      roots.delete(root);
    },
  };
}

const flush = () => act(async () => {});

describe("useTurnstile", () => {
  it("is explicitly off without a site key, with no script or fake token", async () => {
    const scripts = interceptScripts();
    const form = await mount({ siteKey: undefined });
    expect(form.check.state).toBe("off");
    await expect(form.take()).resolves.toBeUndefined();
    expect(scripts).toHaveLength(0);
  });

  it("can wait for a press before loading the check", async () => {
    const scripts = interceptScripts();
    const form = await mount({ eager: false });
    expect(form.check.state).toBe("idle");
    expect(scripts).toHaveLength(0);
    const cancelled = expect(form.take()).rejects.toMatchObject({ reason: "cancelled" });
    expect(scripts).toHaveLength(1);
    form.unmount();
    await cancelled;
  });

  it("takes a ready token synchronously once, even with two calls in one tick", async () => {
    const { widgets } = provider();
    const form = await mount();
    act(() => widgets[0]!.callback("first"));
    let first: Promise<string | undefined> | undefined;
    let second: Promise<string | undefined> | undefined;
    act(() => {
      first = form.check.take();
      second = form.check.take();
    });
    await expect(first).resolves.toBe("first");
    await flush();
    act(() => widgets[1]!.callback("second"));
    await expect(second).resolves.toBe("second");
  });

  it("gives a pending token to one caller and rejects another as busy", async () => {
    const { widgets } = provider();
    const form = await mount();
    const first = form.take();
    await expect(form.take()).rejects.toMatchObject({ reason: "busy" });
    act(() => widgets[0]!.callback("only-once"));
    await expect(first).resolves.toBe("only-once");
  });

  it("handles a token returned inside render and removes the ended widget", async () => {
    const { widgets, api } = provider((options) => options.callback("ready"));
    const form = await mount({ eager: false });
    await expect(form.take()).resolves.toBe("ready");
    await flush();
    expect(widgets.length).toBe(2);
    expect(api.remove).toHaveBeenCalledWith("1");
  });

  it("discards expired tokens, including an expiry callback delayed by a sleeping tab", async () => {
    vi.useFakeTimers();
    const { widgets } = provider();
    const form = await mount();
    act(() => widgets[0]!.callback("old"));
    vi.setSystemTime(Date.now() + 300_001);
    const next = form.take();
    await flush();
    act(() => widgets[1]!.callback("fresh"));
    await expect(next).resolves.toBe("fresh");
    await flush();
    act(() => widgets[2]!.callback("expires"));
    act(() => widgets[2]!["expired-callback"]());
    expect(form.check.state).toBe("loading");
  });

  it("shows an interactive check, fails, and retries without retaining the token", async () => {
    const { widgets } = provider();
    const form = await mount({ language: "pt-BR", theme: "light" });
    expect(widgets[0]).toMatchObject({ language: "pt-br", action: "contact", theme: "light" });
    act(() => widgets[0]!["before-interactive-callback"]());
    expect(form.check.state).toBe("interactive");
    const refused = expect(form.take()).rejects.toMatchObject({ reason: "failed" });
    act(() => expect(widgets[0]!["error-callback"]()).toBe(true));
    await refused;
    expect(form.check.state).toBe("failed");
    act(() => form.check.retry());
    await flush();
    act(() => widgets[0]!.callback("stale"));
    expect(form.check.state).toBe("loading");
    act(() => widgets[1]!.callback("new"));
    expect(form.check.state).toBe("ready");
  });

  it("bounds a token wait and ignores a late answer", async () => {
    vi.useFakeTimers();
    const { widgets } = provider();
    const form = await mount();
    const refused = expect(form.take()).rejects.toMatchObject({ reason: "failed" });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await refused;
    act(() => widgets[0]!.callback("too-late"));
    expect(form.check.state).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels on unmount and option changes, and ignores old callbacks", async () => {
    const { widgets, api } = provider();
    const form = await mount();
    const changed = expect(form.take()).rejects.toMatchObject({ reason: "cancelled" });
    await form.change({ action: "signup" });
    await changed;
    act(() => widgets[0]!.callback("wrong-action"));
    expect(form.check.state).toBe("loading");
    expect(widgets[1]?.action).toBe("signup");
    const cancelled = expect(form.take()).rejects.toMatchObject({ reason: "cancelled" });
    form.unmount();
    await cancelled;
    expect(api.remove).toHaveBeenCalledWith("1");
    expect(api.remove).toHaveBeenCalledWith("2");
  });

  it("owns each widget independently and survives StrictMode's ref cleanup", async () => {
    const { widgets } = provider();
    const first = await mount({}, true);
    const second = await mount({ action: "signup" });
    const a = first.take();
    const b = second.take();
    act(() => widgets[0]!.callback("a"));
    act(() => widgets[1]!.callback("b"));
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
  });
});

describe("Turnstile script loading", () => {
  it("retries a synchronous insertion failure and never renders after unmount", async () => {
    vi.useFakeTimers();
    const scripts = interceptScripts();
    vi.mocked(document.head.append).mockImplementationOnce(() => {
      throw new Error("script insertion blocked");
    });
    const form = await mount();
    expect(form.check.state).toBe("unavailable");
    act(() => form.check.retry());
    expect(scripts).toHaveLength(1);
    form.unmount();
    const { widgets } = provider();
    await act(async () => scripts[0]!.dispatchEvent(new Event("load")));
    expect(widgets).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one script, times out, detaches old handlers and really retries", async () => {
    vi.useFakeTimers();
    const scripts = interceptScripts();
    const first = await mount();
    const second = await mount();
    expect(scripts).toHaveLength(1);
    const old = scripts[0]!;
    const remove = vi.spyOn(old, "remove");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(first.check.state).toBe("unavailable");
    expect(second.check.state).toBe("unavailable");
    expect(remove).toHaveBeenCalledOnce();
    expect(old.onload).toBeNull();
    expect(old.onerror).toBeNull();
    act(() => first.check.retry());
    expect(scripts).toHaveLength(2);
    const { widgets } = provider();
    await act(async () => scripts[1]!.dispatchEvent(new Event("load")));
    expect(widgets).toHaveLength(1);
    expect(first.check.state).toBe("loading");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an empty script and removes no script owned by another caller", async () => {
    const scripts = interceptScripts();
    const foreign = document.createElement("script");
    foreign.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    const remove = vi.spyOn(foreign, "remove");
    const form = await mount();
    await act(async () => scripts[0]!.dispatchEvent(new Event("load")));
    expect(form.check.state).toBe("unavailable");
    expect(remove).not.toHaveBeenCalled();
    act(() => form.check.retry());
    await act(async () => scripts[1]!.dispatchEvent(new Event("error")));
    expect(form.check.state).toBe("unavailable");
    act(() => form.check.retry());
    expect(scripts).toHaveLength(3);
    form.unmount();
  });
});
