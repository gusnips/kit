// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKeyLifecycle,
  KeyScopeChangedError,
  useKeyReveals,
  type KeyLifecycle,
  type RevealedKey,
} from "./keys.ts";

interface KeyRecord {
  id: string;
  name: string;
  prefix: string;
}

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

function minted(id: string): RevealedKey<KeyRecord> {
  const key = `sk_live_${id}_${"x".repeat(24)}`;
  return { record: { id, name: `key ${id}`, prefix: key.slice(0, 10) }, key };
}

/** A request the test answers by hand, to hold it in flight across a navigation. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function lifecycleIn(scope: string | null = "account-1:workspace-1") {
  const keys = createKeyLifecycle<KeyRecord>();
  keys.setScope(scope);
  // Each test leaves the window as it found it: no unread secrets means no unload listener.
  cleanups.push(() => keys.setScope(null));
  return keys;
}

/** The prompt shows only when a listener cancels the event. */
function closingPrompts(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("createKeyLifecycle", () => {
  it("keeps every unread secret, newest first, and resolves only the record", async () => {
    const keys = lifecycleIn();
    const first = await keys.create(async () => minted("a"));
    await keys.create(async () => minted("b"));

    expect(first).toEqual(minted("a").record);
    expect(keys.getSnapshot().map((one) => one.key)).toEqual([minted("b").key, minted("a").key]);
    keys.dismiss("b");
    expect(keys.getSnapshot()).toEqual([minted("a")]);
  });

  it("refuses a record that still holds the secret", async () => {
    const keys = lifecycleIn();
    // The whole answer passed as the record: the shape every donor's mutation cache ended up with.
    const { record, key } = minted("a");
    const answer = { ...record, key };
    await expect(keys.create(async () => ({ record: answer, key }))).rejects.toThrow(
      "still holds the secret",
    );
    expect(keys.getSnapshot()).toEqual([]);
  });

  it("sends nothing before a scope is set", async () => {
    const keys = lifecycleIn(null);
    const request = vi.fn(async () => minted("a"));
    await expect(keys.create(request)).rejects.toThrow("setScope");
    await expect(keys.revoke("a", request)).rejects.toThrow("setScope");
    expect(request).not.toHaveBeenCalled();
  });

  it("a new scope forgets every secret and refuses answers from the old one", async () => {
    const keys = lifecycleIn("account-1:workspace-1");
    await keys.create(async () => minted("a"));
    keys.setScope("account-1:workspace-1");
    expect(keys.getSnapshot()).toHaveLength(1);

    const late = deferred<RevealedKey<KeyRecord>>();
    const creating = keys.create(() => late.promise);
    // Signed out and straight back in as the same account: still not the scope that asked.
    keys.setScope(null);
    keys.setScope("account-1:workspace-1");
    late.resolve(minted("b"));

    const refused = await creating.catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(KeyScopeChangedError);
    expect(refused).toMatchObject({ operation: "create" });
    expect(keys.getSnapshot()).toEqual([]);
  });

  it("a failed revoke keeps the secret, and a success forgets only that key", async () => {
    const keys = lifecycleIn();
    await keys.create(async () => minted("a"));
    await keys.create(async () => minted("b"));

    await expect(
      keys.revoke("a", async () => Promise.reject(new Error("offline"))),
    ).rejects.toThrow("offline");
    expect(keys.getSnapshot()).toHaveLength(2);

    await keys.revoke("a", async () => undefined);
    expect(keys.getSnapshot()).toEqual([minted("b")]);
  });

  it("a revoke answered after the scope changed forgets nothing in the new one", async () => {
    const keys = lifecycleIn("account-1:workspace-1");
    const late = deferred<void>();
    const revoking = keys.revoke("a", () => late.promise);
    keys.setScope("account-1:workspace-2");
    await keys.create(async () => minted("a"));
    late.resolve();

    await expect(revoking).rejects.toMatchObject({ operation: "revoke" });
    expect(keys.getSnapshot()).toEqual([minted("a")]);
  });

  it("asks before the tab closes only while a secret is unread, per lifecycle", async () => {
    const one = lifecycleIn();
    const other = lifecycleIn();
    expect(closingPrompts()).toBe(false);

    await one.create(async () => minted("a"));
    await other.create(async () => minted("b"));
    expect(closingPrompts()).toBe(true);

    other.dismiss("b");
    expect(closingPrompts()).toBe(true);
    one.setScope(null);
    expect(closingPrompts()).toBe(false);
  });
});

describe("with react-query", () => {
  function app(keys: KeyLifecycle<KeyRecord>, server: { list: KeyRecord[] }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    cleanups.push(() => act(() => root.unmount()));
    let route: "keys" | "docs" = "keys";
    let mint: ((request: () => Promise<RevealedKey<KeyRecord>>) => void) | undefined;
    let shown: readonly RevealedKey<KeyRecord>[] = [];

    function KeysPage() {
      useQuery({ queryKey: ["keys"], queryFn: async () => server.list });
      const create = useMutation({
        mutationFn: (request: () => Promise<RevealedKey<KeyRecord>>) => keys.create(request),
        onSuccess: () => client.invalidateQueries({ queryKey: ["keys"] }),
      });
      const reveals = useKeyReveals(keys);
      useLayoutEffect(() => {
        mint = create.mutate;
        shown = reveals;
      });
      return createElement("p", null, reveals.map((one) => one.key).join(","));
    }

    const render = () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          route === "keys" ? createElement(KeysPage) : createElement("p", null, "docs"),
        ),
      );
    act(render);

    return {
      client,
      element,
      get shown() {
        return shown;
      },
      mint(request: () => Promise<RevealedKey<KeyRecord>>) {
        act(() => mint?.(request));
      },
      go(next: "keys" | "docs") {
        route = next;
        act(render);
      },
    };
  }

  it("a create in flight still reveals its secret after the page unmounts", async () => {
    const keys = lifecycleIn();
    const screen = app(keys, { list: [] });
    const late = deferred<RevealedKey<KeyRecord>>();
    screen.mint(() => late.promise);

    screen.go("docs");
    await act(async () => late.resolve(minted("a")));
    expect(keys.getSnapshot()).toEqual([minted("a")]);

    screen.go("keys");
    expect(screen.shown).toEqual([minted("a")]);
    expect(screen.element.textContent).toBe(minted("a").key);
  });

  it("no secret reaches the mutation cache or the list cache", async () => {
    const keys = lifecycleIn();
    const server = { list: [] as KeyRecord[] };
    const screen = app(keys, server);
    const { record, key } = minted("a");

    screen.mint(async () => {
      server.list = [record];
      return { record, key };
    });
    await act(() =>
      vi.waitFor(() => expect(screen.client.getQueryData(["keys"])).toEqual([record])),
    );

    const caches = JSON.stringify([
      screen.client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
      screen.client
        .getQueryCache()
        .getAll()
        .map((query) => query.state),
    ]);
    expect(caches).toContain(record.prefix);
    expect(caches).not.toContain(key);
    expect(keys.getSnapshot()).toEqual([{ record, key }]);
  });

  it("a prerender prints no secret", async () => {
    const keys = lifecycleIn();
    await keys.create(async () => minted("a"));
    function Reveals() {
      return createElement("p", null, useKeyReveals(keys).length);
    }
    expect(renderToString(createElement(Reveals))).toBe("<p>0</p>");
  });
});
