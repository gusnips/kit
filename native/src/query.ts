/**
 * React Query on a phone: "focused" means the app is in the foreground, and "online" means NetInfo
 * says so. React Query's own defaults read the browser's window and `navigator.onLine`, and a
 * phone has neither.
 *
 * What this changes, so nobody expects more of it: a query's retries wait while the app is in the
 * background or the phone is offline, and resume after; stale queries run again when the connection
 * comes back (`refetchOnReconnect`, which `queryDefaults` turns on). It does NOT refetch when the app
 * returns to the foreground, because `queryDefaults` leaves `refetchOnWindowFocus` off on purpose.
 * The donor's comment said "refetch on app foreground" over a client where that option was off, so
 * a screen still mounted from yesterday shows yesterday's data until something else refetches it.
 * Pass `queryDefaults({ refetchOnWindowFocus: true })` if returning to the app should refresh.
 */
import NetInfo from "@react-native-community/netinfo";
import { focusManager, onlineManager } from "@tanstack/react-query";
import { AppState } from "react-native";

/**
 * Call once, before the first query runs, beside where you build the `QueryClient`.
 *
 * ```ts
 * installQueryManagers();
 * export const queryClient = new QueryClient({ defaultOptions: queryDefaults() });
 * ```
 *
 * The managers are React Query's own singletons, so a second call replaces the first rather than
 * adding a second listener.
 */
export function installQueryManagers(): void {
  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener("change", (state) =>
      setFocused(state === "active"),
    );
    return () => subscription.remove();
  });
  // `!== false`, not `=== true`: NetInfo says `null` until it knows, and paused queries at every
  // launch would be the price of reading that as offline.
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => setOnline(state.isConnected !== false)),
  );
}
