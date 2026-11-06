// @vitest-environment happy-dom
import {
  focusManager,
  keepPreviousData,
  MutationCache,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, createElement, StrictMode, useLayoutEffect, type ChangeEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api-client.ts";
import {
  createOAuthConsoleApi,
  formatUserCode,
  OAuthOperationChangedError,
  useConsentRequest,
  useDeviceApproval,
  useDeviceCodeField,
  type ConsentApi,
  type ConsentView,
  type DeviceApi,
  type DeviceView,
  type OAuthRefusal,
  type OAuthScope,
} from "./oauth.ts";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const roots = new Set<Root>();
const clients = new Set<QueryClient>();
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.clear();
  for (const client of clients) client.clear();
  clients.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

const SCOPE: OAuthScope = { key: ["account-a", "workspace-1", 0], isCurrent: () => true };

/** The app's identity generation advances even when an account leaves and comes straight back. */
function identityBoundary() {
  let generation = 0;
  return {
    capture(account = "account-a"): OAuthScope {
      const started = generation;
      return { key: [account, "workspace-1", started], isCurrent: () => started === generation };
    },
    change() {
      generation++;
    },
  };
}

/** Renders `hook` under a real query client and keeps its latest answer in `current`. */
function mount<T>(
  hook: () => T,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  strict = false,
) {
  const seen: T[] = [];
  clients.add(client);
  function Probe() {
    seen.push(hook());
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.add(root);
  const render = () => {
    const page = createElement(QueryClientProvider, { client }, createElement(Probe));
    act(() => root.render(strict ? createElement(StrictMode, null, page) : page));
  };
  render();
  return {
    client,
    render,
    unmount() {
      act(() => root.unmount());
      roots.delete(root);
    },
    get current(): T {
      const last = seen.at(-1);
      if (last === undefined) throw new Error("The hook never rendered");
      return last;
    },
  };
}

function deferred<T>() {
  let resolve!: (answer: T) => void;
  const promise = new Promise<T>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

/**
 * Lets pending promises and the renders they cause finish. react-query hands its updates to a
 * scheduler that runs on a later task, so one tick is not always enough.
 */
const settle = () =>
  act(async () => {
    for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

const VIEW: ConsentView = {
  ok: true,
  clientName: "Claude",
  redirectHost: "claude.ai",
  keyName: "Claude (claude.ai)",
  cancelUrl: "https://claude.ai/cb?error=access_denied",
};
const REFUSAL: OAuthRefusal = {
  ok: false,
  reason: "redirect-mismatch",
  message: "This app's sign-in link is not valid.",
};

describe("useConsentRequest", () => {
  it("loads the request, approves with the page's choice, and leaves for the redirect", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    let release!: () => void;
    const api: ConsentApi<string> = {
      describe: vi.fn(async () => VIEW),
      approve: vi.fn(
        () =>
          new Promise<{ ok: true; redirectTo: string }>((resolve) => {
            release = () => resolve({ ok: true, redirectTo: "https://claude.ai/cb?code=c1" });
          }),
      ),
    };
    const page = mount(() => useConsentRequest(api, "?client_id=x&state=s", SCOPE));
    expect(page.current.state).toEqual({ status: "loading" });
    await settle();
    expect(page.current.state).toEqual({ status: "ready", view: VIEW });
    expect(api.describe).toHaveBeenCalledWith("client_id=x&state=s", {
      signal: expect.any(AbortSignal),
    });

    act(() => page.current.approve("ws-1"));
    await settle();
    expect(api.approve).toHaveBeenCalledWith("client_id=x&state=s", "ws-1", {
      signal: expect.any(AbortSignal),
    });
    expect(page.current.leaving).toBe(true);

    release();
    await settle();
    expect(assign).toHaveBeenCalledWith("https://claude.ai/cb?code=c1");
    // The page is going away: the button must not come back for a second press.
    expect(page.current.leaving).toBe(true);
  });

  it("hands the page whatever its server adds to the view, typed", async () => {
    const api: ConsentApi<string, { spaces: string[] }> = {
      describe: async () => ({ ...VIEW, spaces: ["ws-1", "ws-2"] }),
      approve: async () => ({ ok: true, redirectTo: "https://claude.ai/cb" }),
    };
    const page = mount(() => useConsentRequest(api, "?client_id=x", SCOPE));
    await settle();
    const { state } = page.current;
    expect(state.status === "ready" ? state.view.spaces : null).toEqual(["ws-1", "ws-2"]);
  });

  it("shows a refusal as a state and never redirects on it", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const page = mount(() =>
      useConsentRequest({ describe: async () => REFUSAL, approve: vi.fn() }, "?client_id=x", SCOPE),
    );
    await settle();
    expect(page.current.state).toEqual({ status: "refused", refusal: REFUSAL });
    expect(assign).not.toHaveBeenCalled();
  });

  it("turns a refusal from approve into the refused state, and stays put", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const page = mount(() =>
      useConsentRequest({ describe: async () => VIEW, approve: async () => REFUSAL }, "", SCOPE),
    );
    await settle();
    act(() => page.current.approve());
    await settle();
    expect(page.current.state).toEqual({ status: "refused", refusal: REFUSAL });
    expect(page.current.leaving).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("offers a retry when the request failed to answer, and recovers", async () => {
    let calls = 0;
    const page = mount(() =>
      useConsentRequest(
        {
          describe: async () => {
            calls += 1;
            if (calls === 1) throw new TypeError("Failed to fetch");
            return VIEW;
          },
          approve: vi.fn(),
        },
        "?a=1",
        SCOPE,
      ),
    );
    await settle();
    const failed = page.current.state;
    if (failed.status !== "failed") throw new Error(`expected failed, got ${failed.status}`);
    expect(failed.error).toBeInstanceOf(TypeError);
    act(() => failed.retry());
    await settle();
    expect(page.current.state).toEqual({ status: "ready", view: VIEW });
  });

  it("keeps an approve that did not answer beside the button, ready to press again", async () => {
    const page = mount(() =>
      useConsentRequest(
        {
          describe: async () => VIEW,
          approve: async () => {
            throw new TypeError("Failed to fetch");
          },
        },
        "",
        SCOPE,
      ),
    );
    await settle();
    act(() => page.current.approve());
    await settle();
    expect(page.current.approveError).toBeInstanceOf(TypeError);
    expect(page.current.leaving).toBe(false);
    expect(page.current.state.status).toBe("ready");
  });
});

const DEVICE: DeviceView = {
  ok: true,
  clientName: "Acme CLI",
  userCode: "WDJB-MJHT",
  keyName: "Acme CLI (device sign-in)",
  expiresAt: "2026-10-16T12:10:00.000Z",
};

function deviceApi(overrides: Partial<DeviceApi> = {}) {
  return {
    describe: vi.fn<DeviceApi["describe"]>(overrides.describe ?? (async () => DEVICE)),
    decide: vi.fn<DeviceApi["decide"]>(overrides.decide ?? (async () => ({ ok: true }))),
  };
}

describe("useDeviceApproval", () => {
  it("starts from the link's code, asks the server, and stays approved after the yes", async () => {
    const api = deviceApi();
    const page = mount(() => useDeviceApproval(api, "?code=wdjb-mjht", SCOPE));
    expect(page.current.code).toBe("WDJB-MJHT");
    await settle();
    expect(page.current.state).toEqual({ status: "ready", view: DEVICE });
    expect(api.describe).toHaveBeenCalledWith("WDJBMJHT", { signal: expect.any(AbortSignal) });

    act(() => page.current.approve());
    await settle();
    expect(api.decide).toHaveBeenCalledWith("WDJBMJHT", "approve", undefined, {
      signal: expect.any(AbortSignal),
    });
    expect(page.current.state).toEqual({ status: "approved" });

    // A refetch on focus would now hear "unknown code". It must not be asked.
    api.describe.mockResolvedValue({ ok: false, reason: "unknown-code", message: "gone" });
    await act(async () => page.client.invalidateQueries());
    await settle();
    expect(page.current.state).toEqual({ status: "approved" });
    expect(api.describe).toHaveBeenCalledTimes(1);
  });

  it("waits for all eight letters before asking, and flags a vowel at once", async () => {
    const api = deviceApi();
    const page = mount(() => useDeviceApproval(api, "", SCOPE));
    expect(page.current.state).toEqual({ status: "typing" });
    act(() => page.current.setCode("wdjb m"));
    expect(page.current.code).toBe("WDJB-M");
    act(() => page.current.setCode("WDJA"));
    expect(page.current.invalidLetter).toBe(true);
    act(() => page.current.setCode("WDJB MJHTX"));
    expect(page.current.code).toBe("WDJB-MJHT");
    await settle();
    expect(api.describe).toHaveBeenCalledTimes(1);
    expect(page.current.state.status).toBe("ready");
  });

  it("says no, and shows a code the server does not know as refused", async () => {
    const api = deviceApi();
    const said = mount(() => useDeviceApproval(api, "?code=WDJBMJHT", SCOPE));
    await settle();
    act(() => said.current.deny());
    await settle();
    expect(said.current.state).toEqual({ status: "denied" });
    expect(api.decide).toHaveBeenCalledWith("WDJBMJHT", "deny", undefined, {
      signal: expect.any(AbortSignal),
    });

    const unknown: OAuthRefusal = { ok: false, reason: "unknown-code", message: "expired" };
    const gone = mount(() =>
      useDeviceApproval(deviceApi({ describe: async () => unknown }), "?code=WDJBMJHT", SCOPE),
    );
    await settle();
    expect(gone.current.state).toEqual({ status: "refused", refusal: unknown });
  });

  it("shows a decision the server refused, and lets a new code start over", async () => {
    const unknown: OAuthRefusal = { ok: false, reason: "unknown-code", message: "expired" };
    const api = deviceApi({ decide: async () => unknown });
    const page = mount(() => useDeviceApproval(api, "?code=WDJBMJHT", SCOPE));
    await settle();
    act(() => page.current.approve());
    await settle();
    expect(page.current.state).toEqual({ status: "refused", refusal: unknown });
    act(() => page.current.setCode("BCDF GHJK"));
    await settle();
    expect(page.current.state.status).toBe("ready");
  });
});

describe("useDeviceApproval with a choice", () => {
  it("sends the page's choice with the yes, and names the pressed button until it answers", async () => {
    let release!: () => void;
    const decide = vi.fn<DeviceApi<string>["decide"]>(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const page = mount(() =>
      useDeviceApproval({ describe: async () => DEVICE, decide }, "?code=WDJBMJHT", SCOPE),
    );
    await settle();
    expect(page.current.pending).toBeNull();

    act(() => page.current.approve("ws-1"));
    await settle();
    expect(decide).toHaveBeenCalledWith("WDJBMJHT", "approve", "ws-1", {
      signal: expect.any(AbortSignal),
    });
    expect(page.current.pending).toBe("approve");

    release();
    await settle();
    expect(page.current.pending).toBeNull();
    expect(page.current.state).toEqual({ status: "approved" });
  });
});

/** The one part of a change event the field reads. A test-only cast: the hook takes React's own. */
const changeTo = (value: string) => ({ target: { value } }) as ChangeEvent<HTMLInputElement>;

describe("useDeviceCodeField", () => {
  it("keeps every typed character when the page reads its own URL writes", () => {
    window.history.replaceState(null, "", "/device");
    const api = deviceApi();
    const page = mount(() => {
      const device = useDeviceApproval(api, window.location.search, SCOPE);
      return { device, field: useDeviceCodeField(device) };
    });
    for (const code of ["B", "BC", "BCD", "BCDF"]) {
      act(() => page.current.field.inputProps.onChange(changeTo(code)));
      expect(page.current.device.code).toBe(code);
      expect(new URLSearchParams(window.location.search).get("code")).toBe(code);
    }
    window.history.replaceState(null, "", "/device?code=WDJBMJHT");
    page.render();
    expect(page.current.device.code).toBe("WDJB-MJHT");
  });

  it.each(["approve", "deny"] as const)(
    "keeps the terminal %s result when clearing its own URL, but accepts an external code",
    async (decision) => {
      window.history.replaceState(null, "", "/device?code=WDJBMJHT");
      const api = deviceApi();
      const page = mount(() => {
        const device = useDeviceApproval(api, window.location.search, SCOPE);
        return { device, field: useDeviceCodeField(device) };
      });
      await settle();
      act(() => page.current.device[decision]());
      await settle();
      page.render();
      expect(window.location.search).toBe("");
      expect(page.current.device.state.status).toBe(decision === "approve" ? "approved" : "denied");
      expect(page.current.device.code).toBe("WDJB-MJHT");
      window.history.replaceState(null, "", "/device?code=BCDFGHJK");
      page.render();
      await settle();
      expect(page.current.device.code).toBe("BCDF-GHJK");
      expect(page.current.device.state.status).toBe("ready");
    },
  );

  it("wires the field to its status line and keeps the code in the address until decided", async () => {
    window.history.replaceState({ idx: 3 }, "", "/device?from=mail&code=wdjbmjht");
    const api = deviceApi();
    const page = mount(() => {
      const device = useDeviceApproval(api, window.location.search, SCOPE);
      return { device, field: useDeviceCodeField(device) };
    });
    await settle();
    const { inputProps, statusProps } = page.current.field;
    expect(inputProps).toMatchObject({
      value: "WDJB-MJHT",
      autoFocus: false,
      disabled: false,
      "aria-invalid": false,
      "aria-describedby": statusProps.id,
    });
    expect(inputProps.id).not.toBe(statusProps.id);
    expect(window.location.search).toBe("?from=mail&code=WDJB-MJHT");
    // Replaced with the router's own entry state, or its next Back lands on the wrong page.
    expect(window.history.state).toEqual({ idx: 3 });
    expect(window.history.length).toBe(1);

    act(() => page.current.field.inputProps.onChange(changeTo("bcda")));
    expect(page.current.field.inputProps["aria-invalid"]).toBe(true);
    expect(window.location.search).toBe("?from=mail&code=BCDA");

    act(() => page.current.field.inputProps.onChange(changeTo("wdjb mjht")));
    await settle();
    act(() => page.current.device.approve());
    await settle();
    expect(page.current.device.state).toEqual({ status: "approved" });
    // The server no longer knows the code: a reload must not ask about it and say it is wrong.
    expect(window.location.search).toBe("?from=mail");
  });

  it("focuses the field only when it starts empty", () => {
    window.history.replaceState(null, "", "/device");
    const page = mount(() => useDeviceCodeField(useDeviceApproval(deviceApi(), "", SCOPE)));
    expect(page.current.inputProps.autoFocus).toBe(true);
    expect(window.location.search).toBe("");
  });
});

describe("createOAuthConsoleApi", () => {
  function client(answer: (url: string) => unknown = () => ({ ok: true })) {
    const sent: { url: string; method?: string; body?: BodyInit | null }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      sent.push({ url: String(url), method: init?.method, body: init?.body });
      return new Response(JSON.stringify({ data: answer(String(url)) }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const http = createApiClient({
      baseUrl: "https://api.test",
      session: {
        getToken: async () => "token",
        refresh: async () => ({ token: "token", reachedAuth: true }),
        signOut: async () => {},
      },
      onSessionDead: () => {},
    });
    return { http, sent };
  }

  it("calls the server's console routes through the app's own client", async () => {
    const { http, sent } = client();
    const api = createOAuthConsoleApi<string>(http, "/auth/oauth");
    await api.consent.describe("client_id=x&state=s");
    await api.consent.approve("client_id=x&state=s", "ws-1");
    await api.device.describe("WDJBMJHT");
    await api.device.decide("WDJBMJHT", "approve", "ws-1");
    await api.device.decide("WDJBMJHT", "deny");
    expect(sent).toEqual([
      { url: "https://api.test/auth/oauth/request?client_id=x&state=s", method: "GET" },
      {
        url: "https://api.test/auth/oauth/approve",
        method: "POST",
        body: '{"query":"client_id=x&state=s","choice":"ws-1"}',
      },
      { url: "https://api.test/auth/oauth/device?code=WDJBMJHT", method: "GET" },
      {
        url: "https://api.test/auth/oauth/device",
        method: "POST",
        body: '{"code":"WDJBMJHT","decision":"approve","choice":"ws-1"}',
      },
      {
        url: "https://api.test/auth/oauth/device",
        method: "POST",
        body: '{"code":"WDJBMJHT","decision":"deny"}',
      },
    ]);
  });

  it("sends no choice when the page has none", async () => {
    const { http, sent } = client();
    await createOAuthConsoleApi(http, "/app/oauth").consent.approve("client_id=x");
    expect(sent[0]?.body).toBe('{"query":"client_id=x"}');
  });

  it("keeps the fields your server adds to each page's view", async () => {
    type Workspaces = { workspaces: { id: string; name: string }[] };
    type Account = { accountEmail: string };
    const { http } = client((url) =>
      url.includes("/request")
        ? { ...VIEW, workspaces: [{ id: "ws-1", name: "Acme" }] }
        : { ...DEVICE, accountEmail: "ana@example.com" },
    );
    const api = createOAuthConsoleApi<string, Workspaces, Account>(http, "/auth/oauth");
    const consent = mount(() => useConsentRequest(api.consent, "?client_id=x", SCOPE));
    const device = mount(() => useDeviceApproval(api.device, "?code=WDJB-MJHT", SCOPE));
    await settle();
    const consentState = consent.current.state;
    const deviceState = device.current.state;
    if (consentState.status !== "ready" || deviceState.status !== "ready")
      throw new Error("A view never loaded");

    // These read with no cast: the page keeps the types its server adds.
    expect(consentState.view.workspaces[0]?.name).toBe("Acme");
    expect(deviceState.view.accountEmail).toBe("ana@example.com");
    // @ts-expect-error: the server sends no such field.
    expect(consentState.view.plan).toBeUndefined();
    // @ts-expect-error: the consent page's fields are not the device page's.
    expect(deviceState.view.workspaces).toBeUndefined();
  });

  it("forwards query cancellation through both describe endpoints to fetch", async () => {
    const { http } = client();
    const signals: AbortSignal[] = [];
    vi.mocked(fetch).mockImplementation((_url, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error("Missing query cancellation signal");
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const api = createOAuthConsoleApi(http, "/auth/oauth");
    const page = mount(() => ({
      consent: useConsentRequest(api.consent, "?client_id=x", SCOPE),
      device: useDeviceApproval(api.device, "?code=WDJBMJHT", SCOPE),
    }));
    await settle();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await act(async () => page.client.cancelQueries());
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("aborts both decision transports and rejects completed responses after an identity boundary", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const { http } = client();
    const consentAnswer = deferred<Response>();
    const deviceAnswer = deferred<Response>();
    const signals: AbortSignal[] = [];
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      if (options?.method === "POST") {
        if (!options.signal) throw new Error("Missing decision cancellation signal");
        signals.push(options.signal);
        // A completed server response may still arrive after transport cancellation.
        return String(url).endsWith("/approve") ? consentAnswer.promise : deviceAnswer.promise;
      }
      return new Response(
        JSON.stringify({ data: String(url).includes("/request") ? VIEW : DEVICE }),
      );
    });
    const boundary = identityBoundary();
    let scope = boundary.capture();
    const api = createOAuthConsoleApi(http, "/auth/oauth");
    const page = mount(() => ({
      consent: useConsentRequest(api.consent, "?client_id=x", scope),
      device: useDeviceApproval(api.device, "?code=WDJBMJHT", scope),
    }));
    await settle();
    act(() => {
      page.current.consent.approve();
      page.current.device.deny();
    });
    await settle();
    const mutations = page.client.getMutationCache().getAll();
    boundary.change();
    scope = boundary.capture("account-b");
    act(() => page.client.clear());
    page.render();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    consentAnswer.resolve(
      new Response(
        JSON.stringify({ data: { ok: true, redirectTo: "https://app.test/cb?code=old" } }),
      ),
    );
    deviceAnswer.resolve(new Response(JSON.stringify({ data: { ok: true } })));
    await settle();
    expect(assign).not.toHaveBeenCalled();
    for (const mutation of mutations) {
      expect(mutation.state.status).toBe("error");
      expect(mutation.state.data).toBeUndefined();
      expect(mutation.state.error).toBeInstanceOf(OAuthOperationChangedError);
    }
    expect(page.current.device.state.status).toBe("ready");
  });
});

describe("OAuth scope and operation lifetime", () => {
  it.each(["input", "scope"] as const)(
    "does not reuse a previous approval target or its extra fields after %s changes",
    async (change) => {
      type Extra = { workspaces: string[] };
      const client = new QueryClient({
        defaultOptions: { queries: { placeholderData: keepPreviousData } },
      });
      const nextConsent = deferred<ConsentView<Extra>>();
      const nextDevice = deferred<DeviceView<Extra>>();
      let changed = false;
      let scope = SCOPE;
      let search = "?client_id=x";
      let code = "?code=WDJBMJHT";
      const oldConsent = { ...VIEW, workspaces: ["old-workspace"] };
      const oldDevice = { ...DEVICE, workspaces: ["old-workspace"] };
      const consent: ConsentApi<void, Extra> = {
        describe: () => (changed ? nextConsent.promise : Promise.resolve(oldConsent)),
        approve: vi.fn(),
      };
      const device: DeviceApi<void, Extra> = {
        describe: () => (changed ? nextDevice.promise : Promise.resolve(oldDevice)),
        decide: vi.fn(),
      };
      const page = mount(
        () => ({
          consent: useConsentRequest(consent, search, scope),
          device: useDeviceApproval(device, code, scope),
        }),
        client,
      );
      await settle();
      expect(page.current.consent.state).toEqual({ status: "ready", view: oldConsent });
      expect(page.current.device.state).toEqual({ status: "ready", view: oldDevice });
      changed = true;
      if (change === "scope") scope = { key: ["account-b", 1], isCurrent: () => true };
      else {
        search = "?client_id=y";
        code = "?code=BCDFGHJK";
      }
      page.render();
      expect(page.current.consent.state).toEqual({ status: "loading" });
      expect(page.current.device.state).toEqual({ status: "loading" });
      const newConsent = { ...VIEW, clientName: "New app", workspaces: ["new-workspace"] };
      const newDevice = { ...DEVICE, clientName: "New script", workspaces: ["new-workspace"] };
      nextConsent.resolve(newConsent);
      nextDevice.resolve(newDevice);
      await settle();
      expect(page.current.consent.state).toEqual({ status: "ready", view: newConsent });
      expect(page.current.device.state).toEqual({ status: "ready", view: newDevice });
    },
  );

  it("invalidates the previous request by the layout commit, before passive cleanup", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const answer = deferred<{ ok: true; redirectTo: string }>();
    let search = "?client_id=x";
    let signal: AbortSignal | undefined;
    let abortedAtCommit = false;
    const api: ConsentApi = {
      describe: async () => VIEW,
      approve: (_query, _choice, options) => {
        signal = options?.signal ?? undefined;
        return answer.promise;
      },
    };
    const page = mount(() => {
      const requestSearch = search;
      const consent = useConsentRequest(api, requestSearch, SCOPE);
      useLayoutEffect(() => {
        if (requestSearch === "?client_id=y") {
          abortedAtCommit = signal?.aborted === true;
          answer.resolve({ ok: true, redirectTo: "https://app.test/cb?code=old" });
        }
      }, [requestSearch]);
      return consent;
    });
    await settle();
    act(() => page.current.approve());
    await settle();
    search = "?client_id=y";
    page.render();
    await settle();
    expect(abortedAtCommit).toBe(true);
    expect(assign).not.toHaveBeenCalled();
    expect(page.client.getMutationCache().getAll()[0]?.state).toMatchObject({
      status: "error",
      data: undefined,
      error: expect.any(OAuthOperationChangedError),
    });
  });

  it.each(["approve", "deny"] as const)(
    "rejects stale consent and device %s after an awaited global settlement",
    async (decision) => {
      const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
      const boundary = identityBoundary();
      const scope = boundary.capture();
      const settlement = deferred<void>();
      const settled = vi.fn((_data: unknown, error: unknown) =>
        error === null ? settlement.promise : undefined,
      );
      const client = new QueryClient({ mutationCache: new MutationCache({ onSettled: settled }) });
      const page = mount(
        () => ({
          consent: useConsentRequest(
            {
              describe: async () => VIEW,
              approve: async () => ({ ok: true, redirectTo: "https://app.test/cb" }),
            },
            "?client_id=x",
            scope,
          ),
          device: useDeviceApproval(deviceApi(), "?code=WDJBMJHT", scope),
        }),
        client,
      );
      await settle();
      act(() => {
        page.current.consent.approve();
        page.current.device[decision]();
      });
      await settle();
      expect(settled).toHaveBeenCalledTimes(2);
      expect(
        client
          .getMutationCache()
          .getAll()
          .every((mutation) => mutation.state.status === "pending"),
      ).toBe(true);
      expect(assign).not.toHaveBeenCalled();
      boundary.change();
      settlement.resolve();
      await settle();
      for (const mutation of client.getMutationCache().getAll()) {
        expect(mutation.state).toMatchObject({
          status: "error",
          data: undefined,
          error: expect.any(OAuthOperationChangedError),
        });
      }
      expect(assign).not.toHaveBeenCalled();
      expect(page.current.device.state.status).not.toBe("approved");
      expect(page.current.device.state.status).not.toBe("denied");
    },
  );

  it("isolates identical requests and codes across scopes in one query client", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const describeConsent = vi.fn(async (account: string) => ({ ...VIEW, clientName: account }));
    const describeDevice = vi.fn(async (account: string) => ({ ...DEVICE, clientName: account }));
    const page = mount(() => {
      const a = { key: ["a", 0], isCurrent: () => true };
      const b = { key: ["b", 0], isCurrent: () => true };
      return {
        a: useConsentRequest({ describe: () => describeConsent("a"), approve: vi.fn() }, "?x=1", a),
        b: useConsentRequest({ describe: () => describeConsent("b"), approve: vi.fn() }, "x=1", b),
        normalized: useConsentRequest(
          { describe: () => describeConsent("duplicate"), approve: vi.fn() },
          "x=1",
          a,
        ),
        deviceA: useDeviceApproval(
          { describe: () => describeDevice("a"), decide: vi.fn() },
          "?code=wdjb-mjht",
          a,
        ),
        deviceB: useDeviceApproval(
          { describe: () => describeDevice("b"), decide: vi.fn() },
          "?code=WDJBMJHT",
          b,
        ),
        normalizedDevice: useDeviceApproval(
          { describe: () => describeDevice("duplicate"), decide: vi.fn() },
          "?code=WDJBMJHT",
          a,
        ),
      };
    }, client);
    await settle();
    expect(page.current.a.state).toEqual({ status: "ready", view: { ...VIEW, clientName: "a" } });
    expect(page.current.b.state).toEqual({ status: "ready", view: { ...VIEW, clientName: "b" } });
    expect(page.current.normalized.state).toEqual(page.current.a.state);
    expect(page.current.deviceA.state).toEqual({
      status: "ready",
      view: { ...DEVICE, clientName: "a" },
    });
    expect(page.current.deviceB.state).toEqual({
      status: "ready",
      view: { ...DEVICE, clientName: "b" },
    });
    expect(page.current.normalizedDevice.state).toEqual(page.current.deviceA.state);
    expect(describeConsent).toHaveBeenCalledTimes(2);
    expect(describeDevice).toHaveBeenCalledTimes(2);
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([
      ["a", 0, "@gusnips/react/oauth", "consent", "x=1"],
      ["b", 0, "@gusnips/react/oauth", "consent", "x=1"],
      ["a", 0, "@gusnips/react/oauth", "device", "WDJBMJHT"],
      ["b", 0, "@gusnips/react/oauth", "device", "WDJBMJHT"],
    ]);
  });

  it.each(["approve", "deny"] as const)(
    "rejects delayed consent and device %s after scope change and cache clear",
    async (pressed) => {
      const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
      const boundary = identityBoundary();
      let scope = boundary.capture();
      const consentAnswer = deferred<{ ok: true; redirectTo: string }>();
      const deviceAnswer = deferred<{ ok: true }>();
      const signals: AbortSignal[] = [];
      const consentApi: ConsentApi = {
        describe: async () => VIEW,
        approve: (_query, _choice, options) => {
          if (options?.signal) signals.push(options.signal);
          return consentAnswer.promise; // Deliberately ignores cancellation: the server may have finished.
        },
      };
      const api = deviceApi({
        decide: (_code, _pressed, _choice, options) => {
          if (options?.signal) signals.push(options.signal);
          return deviceAnswer.promise;
        },
      });
      const page = mount(() => ({
        consent: useConsentRequest(consentApi, "?client_id=x", scope),
        device: useDeviceApproval(api, "?code=WDJBMJHT", scope),
      }));
      await settle();
      act(() => {
        page.current.consent.approve();
        page.current.device[pressed]();
      });
      await settle();
      const oldMutations = page.client.getMutationCache().getAll();
      expect(oldMutations).toHaveLength(2);
      boundary.change();
      scope = boundary.capture("account-b");
      act(() => page.client.clear());
      page.render();
      expect(page.current.consent.leaving).toBe(false);
      expect(page.current.device.deciding).toBe(false);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      consentAnswer.resolve({ ok: true, redirectTo: "https://app.test/cb?code=old" });
      deviceAnswer.resolve({ ok: true });
      await settle();
      expect(assign).not.toHaveBeenCalled();
      for (const mutation of oldMutations) {
        expect(mutation.state.status).toBe("error");
        expect(mutation.state.error).toBeInstanceOf(OAuthOperationChangedError);
        expect(mutation.state.data).toBeUndefined();
      }
      expect(page.current.consent.leaving).toBe(false);
      expect(page.current.device.state.status).toBe("ready");
    },
  );

  it("rejects an old approval after the same account returns, even before React sees the boundary", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const boundary = identityBoundary();
    const scope = boundary.capture();
    const answer = deferred<{ ok: true; redirectTo: string }>();
    const page = mount(() =>
      useConsentRequest(
        { describe: async () => VIEW, approve: () => answer.promise },
        "?x=1",
        scope,
      ),
    );
    await settle();
    act(() => page.current.approve());
    await settle();
    boundary.change(); // A -> B
    boundary.change(); // B -> A, with the same account id but a new generation.
    expect(boundary.capture().key[0]).toBe(scope.key[0]);
    answer.resolve({ ok: true, redirectTo: "https://app.test/cb?code=old" });
    await settle();
    expect(assign).not.toHaveBeenCalled();
    const mutation = page.client.getMutationCache().getAll()[0];
    expect(mutation?.state.status).toBe("error");
    expect(mutation?.state.data).toBeUndefined();
    expect(mutation?.state.error).toBeInstanceOf(OAuthOperationChangedError);
  });

  it("checks identity again after mutation-cache callbacks and before redirecting", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const boundary = identityBoundary();
    const scope = boundary.capture();
    const client = new QueryClient({
      mutationCache: new MutationCache({ onSuccess: () => boundary.change() }),
    });
    const page = mount(
      () =>
        useConsentRequest(
          {
            describe: async () => VIEW,
            approve: async () => ({ ok: true, redirectTo: "https://app.test/cb" }),
          },
          "?x=1",
          scope,
        ),
      client,
    );
    await settle();
    act(() => page.current.approve());
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(client.getMutationCache().getAll()[0]?.state).toMatchObject({
      status: "error",
      data: undefined,
    });
  });

  it.each(["request", "code", "link", "unmount"] as const)(
    "invalidates delayed decisions after %s changes",
    async (change) => {
      const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
      const consentAnswer = deferred<{ ok: true; redirectTo: string }>();
      const deviceAnswer = deferred<{ ok: true }>();
      const signals: AbortSignal[] = [];
      const consentApi: ConsentApi = {
        describe: async () => VIEW,
        approve: (_query, _choice, options) => {
          if (options?.signal) signals.push(options.signal);
          return consentAnswer.promise;
        },
      };
      const api = deviceApi({
        decide: (_code, _decision, _choice, options) => {
          if (options?.signal) signals.push(options.signal);
          return deviceAnswer.promise;
        },
      });
      let search = "?client_id=x";
      let deviceSearch = "?code=WDJBMJHT";
      const page = mount(() => ({
        consent: useConsentRequest(consentApi, search, SCOPE),
        device: useDeviceApproval(api, deviceSearch, SCOPE),
      }));
      await settle();
      act(() => {
        page.current.consent.approve();
        page.current.device.deny();
      });
      await settle();
      if (change === "unmount") page.unmount();
      else if (change === "request") {
        search = "?client_id=y";
        page.render();
      } else if (change === "link") {
        deviceSearch = "?code=BCDFGHJK";
        page.render();
      } else act(() => page.current.device.setCode("BCDFGHJK"));
      consentAnswer.resolve({ ok: true, redirectTo: "https://app.test/cb?code=old" });
      deviceAnswer.resolve({ ok: true });
      await settle();
      const mutations = page.client.getMutationCache().getAll();
      const stale =
        change === "request" ? [mutations[0]] : change === "unmount" ? mutations : [mutations[1]];
      for (const mutation of stale) {
        expect(mutation?.state.status).toBe("error");
        expect(mutation?.state.error).toBeInstanceOf(OAuthOperationChangedError);
        expect(mutation?.state.data).toBeUndefined();
      }
      expect(signals[change === "request" ? 0 : 1]?.aborted).toBe(true);
      if (change === "request" || change === "unmount") expect(assign).not.toHaveBeenCalled();
      else {
        expect(page.current.device.state.status).toBe("ready");
        expect(page.current.device.code).toBe("BCDF-GHJK");
      }
    },
  );

  it("keeps fresh controllers after StrictMode cleanup and accepts new decisions", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const signals: AbortSignal[] = [];
    const consentApi: ConsentApi = {
      describe: async () => VIEW,
      approve: async (_query, _choice, options) => {
        if (options?.signal) signals.push(options.signal);
        return { ok: true, redirectTo: "https://app.test/cb" };
      },
    };
    const api = deviceApi({
      decide: async (_code, _decision, _choice, options) => {
        if (options?.signal) signals.push(options.signal);
        return { ok: true };
      },
    });
    const page = mount(
      () => ({
        consent: useConsentRequest(consentApi, "?x=1", SCOPE),
        device: useDeviceApproval(api, "?code=WDJBMJHT", SCOPE),
      }),
      undefined,
      true,
    );
    await settle();
    act(() => {
      page.current.consent.approve();
      page.current.device.approve();
    });
    await settle();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect(assign).toHaveBeenCalledOnce();
    expect(page.current.device.state.status).toBe("approved");
  });

  it("does not retry or refresh on focus despite aggressive defaults, but allows explicit retries", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: 5, retryDelay: 0, refetchOnWindowFocus: "always" },
        mutations: { retry: 5, retryDelay: 0 },
      },
    });
    let fail = true;
    const describeConsent = vi.fn(async () => {
      if (fail) throw new TypeError("Failed to fetch");
      return VIEW;
    });
    const describeDevice = vi.fn(async () => {
      if (fail) throw new TypeError("Failed to fetch");
      return DEVICE;
    });
    const approve = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const decide = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const page = mount(
      () => ({
        consent: useConsentRequest({ describe: describeConsent, approve }, "?x=1", SCOPE),
        device: useDeviceApproval({ describe: describeDevice, decide }, "?code=WDJBMJHT", SCOPE),
      }),
      client,
    );
    await settle();
    expect(describeConsent).toHaveBeenCalledTimes(1);
    expect(describeDevice).toHaveBeenCalledTimes(1);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await settle();
    expect(describeConsent).toHaveBeenCalledTimes(1);
    expect(describeDevice).toHaveBeenCalledTimes(1);
    fail = false;
    act(() => {
      if (
        page.current.consent.state.status !== "failed" ||
        page.current.device.state.status !== "failed"
      )
        throw new Error("Expected two failures");
      page.current.consent.state.retry();
      page.current.device.state.retry();
    });
    await settle();
    expect(page.current.consent.state.status).toBe("ready");
    expect(page.current.device.state.status).toBe("ready");
    act(() => {
      page.current.consent.approve();
      page.current.device.deny();
    });
    await settle();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(page.current.consent.approveError).toBeInstanceOf(TypeError);
    expect(page.current.device.decideError).toBeInstanceOf(TypeError);
    act(() => {
      page.current.consent.approve();
      page.current.device.deny();
    });
    await settle();
    expect(approve).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("does not queue decisions while offline", async () => {
    const approve = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const api = deviceApi({
      decide: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const page = mount(() => ({
      consent: useConsentRequest({ describe: async () => VIEW, approve }, "?x=1", SCOPE),
      device: useDeviceApproval(api, "?code=WDJBMJHT", SCOPE),
    }));
    await settle();
    onlineManager.setOnline(false);
    act(() => {
      page.current.consent.approve();
      page.current.device.deny();
    });
    await settle();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(
      page.client
        .getMutationCache()
        .getAll()
        .every((mutation) => mutation.state.status === "error" && !mutation.state.isPaused),
    ).toBe(true);
    onlineManager.setOnline(true);
    await settle();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledTimes(1);
  });
});

describe("formatUserCode", () => {
  it("writes what the field shows", () => {
    expect(formatUserCode("")).toBe("");
    expect(formatUserCode("wdj")).toBe("WDJ");
    expect(formatUserCode("wdjb")).toBe("WDJB");
    expect(formatUserCode("wdjbm")).toBe("WDJB-M");
    expect(formatUserCode(" w-d j b m j h t z ")).toBe("WDJB-MJHT");
  });
});
