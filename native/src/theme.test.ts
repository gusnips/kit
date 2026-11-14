import { beforeEach, describe, expect, it, vi } from "vitest";

// React Native and AsyncStorage do not load under Node. These stand in for the parts the theme
// touches, and behave the way RN 0.86's Appearance does: `setColorScheme` changes what
// `getColorScheme` answers at once, and "unspecified" hands back the OS scheme.
const device = vi.hoisted(() => ({
  os: "light" as "light" | "dark",
  override: null as "light" | "dark" | null,
  foreground: [] as ((state: string) => void)[],
  stored: new Map<string, string>(),
  read: null as Promise<string | null> | null,
}));

vi.mock("react-native", () => ({
  Appearance: {
    getColorScheme: () => device.override ?? device.os,
    setColorScheme: (scheme: string) => {
      device.override = scheme === "unspecified" ? null : (scheme as "light" | "dark");
    },
    addChangeListener: () => ({ remove() {} }),
  },
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      device.foreground.push(listener);
      return { remove() {} };
    },
  },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => device.read ?? Promise.resolve(device.stored.get(key) ?? null),
    setItem: async (key: string, value: string) => void device.stored.set(key, value),
  },
}));

const { createNativeTheme } = await import("./theme.ts");

beforeEach(() => {
  device.os = "light";
  device.override = null;
  device.foreground = [];
  device.stored.clear();
  device.read = null;
});

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("createNativeTheme", () => {
  it("applies the stored choice at start", async () => {
    device.stored.set("theme", "dark");
    const theme = createNativeTheme({ key: "theme" });
    expect(theme.getSnapshot()).toEqual({ mode: "system", resolved: "light" });
    theme.start();
    await settle();
    expect(theme.getSnapshot()).toEqual({ mode: "dark", resolved: "dark" });
  });

  it("keeps a choice made while the stored one is still loading", async () => {
    device.stored.set("theme", "light");
    let finishRead!: (value: string | null) => void;
    device.read = new Promise((done) => (finishRead = done));
    const theme = createNativeTheme({ key: "theme" });
    theme.start();
    theme.setMode("dark");
    finishRead("light");
    await settle();
    expect(theme.getSnapshot()).toEqual({ mode: "dark", resolved: "dark" });
    expect(device.stored.get("theme")).toBe("dark");
  });

  it("follows the OS again on system, and keeps one snapshot while nothing changes", () => {
    const theme = createNativeTheme({ key: "theme" });
    theme.setMode("dark");
    expect(theme.getSnapshot()).toEqual({ mode: "dark", resolved: "dark" });
    theme.setMode("system");
    expect(theme.getSnapshot()).toEqual({ mode: "system", resolved: "light" });
    // useSyncExternalStore re-renders on a new object, so an unchanged theme must not make one.
    const before = theme.getSnapshot();
    theme.setMode("system");
    expect(theme.getSnapshot()).toBe(before);
  });

  it("puts the choice back when the app returns to the foreground", async () => {
    const theme = createNativeTheme({ key: "theme" });
    theme.start();
    await settle();
    theme.setMode("dark");
    device.override = null; // Android recreated the activity and dropped the override
    for (const listener of device.foreground) listener("active");
    expect(device.override).toBe("dark");
  });
});
