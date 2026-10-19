// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ChangeEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api-client.ts";
import {
  createOAuthConsoleApi,
  formatUserCode,
  useConsentRequest,
  useDeviceApproval,
  useDeviceCodeField,
  type ConsentApi,
  type ConsentView,
  type DeviceApi,
  type DeviceView,
  type OAuthRefusal,
} from "./oauth.ts";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.clear();
  vi.restoreAllMocks();
});

/** Renders `hook` under a fresh query client and keeps its latest answer in `current`. */
function mount<T>(hook: () => T) {
  const seen: T[] = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Probe() {
    seen.push(hook());
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.add(root);
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Probe))));
  return {
    client,
    get current(): T {
      const last = seen.at(-1);
      if (last === undefined) throw new Error("The hook never rendered");
      return last;
    },
  };
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
    const page = mount(() => useConsentRequest(api, "?client_id=x&state=s"));
    expect(page.current.state).toEqual({ status: "loading" });
    await settle();
    expect(page.current.state).toEqual({ status: "ready", view: VIEW });
    expect(api.describe).toHaveBeenCalledWith("client_id=x&state=s");

    act(() => page.current.approve("ws-1"));
    await settle();
    expect(api.approve).toHaveBeenCalledWith("client_id=x&state=s", "ws-1");
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
    const page = mount(() => useConsentRequest(api, "?client_id=x"));
    await settle();
    const { state } = page.current;
    expect(state.status === "ready" ? state.view.spaces : null).toEqual(["ws-1", "ws-2"]);
  });

  it("shows a refusal as a state and never redirects on it", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const page = mount(() =>
      useConsentRequest({ describe: async () => REFUSAL, approve: vi.fn() }, "?client_id=x"),
    );
    await settle();
    expect(page.current.state).toEqual({ status: "refused", refusal: REFUSAL });
    expect(assign).not.toHaveBeenCalled();
  });

  it("turns a refusal from approve into the refused state, and stays put", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const page = mount(() =>
      useConsentRequest({ describe: async () => VIEW, approve: async () => REFUSAL }, ""),
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
    const page = mount(() => useDeviceApproval(api, "?code=wdjb-mjht"));
    expect(page.current.code).toBe("WDJB-MJHT");
    await settle();
    expect(page.current.state).toEqual({ status: "ready", view: DEVICE });
    expect(api.describe).toHaveBeenCalledWith("WDJBMJHT");

    act(() => page.current.approve());
    await settle();
    expect(api.decide).toHaveBeenCalledWith("WDJBMJHT", "approve", undefined);
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
    const page = mount(() => useDeviceApproval(api, ""));
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
    const said = mount(() => useDeviceApproval(api, "?code=WDJBMJHT"));
    await settle();
    act(() => said.current.deny());
    await settle();
    expect(said.current.state).toEqual({ status: "denied" });
    expect(api.decide).toHaveBeenCalledWith("WDJBMJHT", "deny", undefined);

    const unknown: OAuthRefusal = { ok: false, reason: "unknown-code", message: "expired" };
    const gone = mount(() =>
      useDeviceApproval(deviceApi({ describe: async () => unknown }), "?code=WDJBMJHT"),
    );
    await settle();
    expect(gone.current.state).toEqual({ status: "refused", refusal: unknown });
  });

  it("shows a decision the server refused, and lets a new code start over", async () => {
    const unknown: OAuthRefusal = { ok: false, reason: "unknown-code", message: "expired" };
    const api = deviceApi({ decide: async () => unknown });
    const page = mount(() => useDeviceApproval(api, "?code=WDJBMJHT"));
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
      useDeviceApproval({ describe: async () => DEVICE, decide }, "?code=WDJBMJHT"),
    );
    await settle();
    expect(page.current.pending).toBeNull();

    act(() => page.current.approve("ws-1"));
    await settle();
    expect(decide).toHaveBeenCalledWith("WDJBMJHT", "approve", "ws-1");
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
  it("wires the field to its status line and keeps the code in the address until decided", async () => {
    window.history.replaceState({ idx: 3 }, "", "/device?from=mail&code=wdjbmjht");
    const api = deviceApi();
    const page = mount(() => {
      const device = useDeviceApproval(api, window.location.search);
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
    const page = mount(() => useDeviceCodeField(useDeviceApproval(deviceApi(), "")));
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
    const consent = mount(() => useConsentRequest(api.consent, "?client_id=x"));
    const device = mount(() => useDeviceApproval(api.device, "?code=WDJB-MJHT"));
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
