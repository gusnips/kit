/**
 * Light, dark, or whatever the phone says, remembered across launches.
 *
 * The phone's half of `@gusnips/react/theme`: the same three modes, the same snapshot and the same
 * `useTheme`, so a settings screen written against one reads the same against the other. What
 * differs is where it lands. On the web the theme is a class on `<html>`; here it is
 * `Appearance.setColorScheme`, which is what `useColorScheme()` and react-native-css's `dark:`
 * variant both read. `"system"` clears the override, so the OS decides again, live.
 *
 * Two things the donor's store taught:
 *
 * - **Android drops the override when the activity is recreated** under a running JS context (a
 *   system overlay, a configuration change), and the app comes back in the OS scheme with the old
 *   choice still in memory. So the choice is applied again every time the app returns to the
 *   foreground. No storage read for that, only the mode already held.
 * - **A choice made while the stored one is still loading wins.** The read is async. A tap on
 *   "Dark" in the first second of a launch must not be undone by the stored "Light" arriving after
 *   it, which the donor's store would have done.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ResolvedTheme, Theme, ThemeMode, ThemeSnapshot } from "@gusnips/react/theme";
import { useSyncExternalStore } from "react";
import { AppState, Appearance } from "react-native";

export type { ResolvedTheme, ThemeMode, ThemeSnapshot };

export interface NativeThemeOptions {
  /** The AsyncStorage key holding the choice. Keep the key your app already uses. */
  key: string;
  /** What an empty or unrecognised key means. Defaults to `"system"`. */
  defaultMode?: ThemeMode;
}

export interface NativeTheme extends Theme {
  /**
   * Load the stored choice, apply it, and keep it applied each time the app comes back to the
   * foreground. Returns the function that stops it, so it fits a root `useEffect` as it is:
   * `useEffect(() => theme.start(), [])`.
   */
  start(): () => void;
}

const MODES: readonly ThemeMode[] = ["light", "dark", "system"];

const isMode = (value: string | null): value is ThemeMode =>
  value !== null && (MODES as readonly string[]).includes(value);

/**
 * Nothing runs at import: the snapshot is read on first use, and storage only in `start()`.
 *
 * ```ts
 * export const theme = createNativeTheme({ key: "app:theme" });
 * ```
 */
export function createNativeTheme({
  key,
  defaultMode = "system",
}: NativeThemeOptions): NativeTheme {
  let mode: ThemeMode = defaultMode;
  let chosen = false;
  let snapshot: ThemeSnapshot | null = null;
  const listeners = new Set<() => void>();
  let appearance: { remove(): void } | null = null;

  const resolved = (): ResolvedTheme => (Appearance.getColorScheme() === "dark" ? "dark" : "light");

  function getSnapshot(): ThemeSnapshot {
    snapshot ??= { mode, resolved: resolved() };
    return snapshot;
  }

  // `useSyncExternalStore` compares snapshots by identity, so a new object goes out only when
  // something a screen can see has changed.
  function publish(): void {
    const next = { mode, resolved: resolved() };
    if (snapshot && snapshot.mode === next.mode && snapshot.resolved === next.resolved) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  // `setColorScheme` updates what `getColorScheme` answers at once, and emits no change event of
  // its own, so this publishes rather than waiting for one.
  function apply(): void {
    Appearance.setColorScheme(mode === "system" ? "unspecified" : mode);
    publish();
  }

  function setMode(next: ThemeMode): void {
    chosen = true;
    mode = next;
    apply();
    AsyncStorage.setItem(key, next).catch(() => {
      // Not remembered across launches, and still applied for this one.
    });
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    // The OS switching scheme (a phone that goes dark at sunset) while the mode is "system".
    appearance ??= Appearance.addChangeListener(publish);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        appearance?.remove();
        appearance = null;
      }
    };
  }

  function start(): () => void {
    AsyncStorage.getItem(key).then(
      (stored) => {
        if (chosen) return;
        mode = isMode(stored) ? stored : defaultMode;
        apply();
      },
      () => {
        // Nothing readable: the default stands, and a choice made now is still applied.
      },
    );
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") apply();
    });
    return () => foreground.remove();
  }

  function useTheme() {
    return { ...useSyncExternalStore(subscribe, getSnapshot), setMode };
  }

  return { useTheme, setMode, getSnapshot, start };
}

/**
 * The colours for the theme on screen, out of the `{ light, dark }` that `gusnips-native-css
 * --palette` writes to `colors.ts`. For what cannot take a `className`: the React Navigation theme,
 * a `RefreshControl` tint, the status bar. It re-renders when the theme changes, the OS's
 * included while the mode is "system".
 *
 * ```ts
 * import { COLORS } from "./generated/colors";
 *
 * const colors = useThemeColors(theme, COLORS);
 * <RefreshControl tintColor={colors.muted} />;
 * ```
 *
 * Any `Theme` fits, the web's from `@gusnips/react/theme` too. Outside React, read
 * `COLORS[theme.getSnapshot().resolved]`.
 */
export function useThemeColors<C>(
  theme: Pick<Theme, "useTheme">,
  colors: { readonly light: C; readonly dark: C },
): C {
  return colors[theme.useTheme().resolved];
}
