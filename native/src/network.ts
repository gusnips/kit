/**
 * Is the phone offline? NetInfo answers, with one rule both helpers here share.
 *
 * `isConnected === false` is offline, and nothing else is. NetInfo reports `null` while it has not
 * worked it out yet, which happens at every launch; reading that as offline puts an offline banner
 * on screen for the first moment of every session.
 */
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { useEffect, useState } from "react";

const offline = (state: NetInfoState) => state.isConnected === false;

/**
 * True while the phone has no connection.
 *
 * React Query already pauses on its own once `installQueryManagers` from `@gusnips/native/query`
 * is running. This is for a screen that should SAY it is offline instead of showing old data as
 * if it were current.
 */
export function useIsOffline(): boolean {
  const [isOffline, setIsOffline] = useState(false);
  useEffect(() => NetInfo.addEventListener((state) => setIsOffline(offline(state))), []);
  return isOffline;
}

/**
 * Was that failure the phone, or the server?
 *
 * React Native's `fetch` rejects with the same bare `TypeError` when the server is down and when
 * the phone has no signal. Ask this before telling somebody the service is having trouble: only a
 * `false` here means the service is to blame. A NetInfo that cannot answer counts as online, so
 * the doubt goes to the message that has a retry beside it.
 */
export async function isDeviceOffline(): Promise<boolean> {
  const state = await NetInfo.fetch().catch(() => null);
  return state !== null && offline(state);
}
